import {
  setPersonalRelationDecisionV2ResultSchema,
  setPersonalRelationDecisionV2Schema,
} from "@astella/shared/personal-relation-decision-rules-v2";
import * as ns_source from "./desktop-gateway-ns-source";
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
import type { InputSchema, NoteDocStreamEntry, ParsedMeta } from "./desktop-ipc";
import type * as ns_note from "./desktop-gateway-ns-note";
/**
 * 「笔记」这一族的 IPC 通道（2026-09-30 从 `desktop-ipc.ts` 搬出，第②步）。
 *
 * ## 搬的是「这一族的全部」——通道**与**它专属的 schema 一起
 *
 * 只搬通道的话，段内会有一堆「在这里 import、定义却在另一个文件」的常量，
 * 读一条通道要跳两个地方。schema 留在原文件、handler 搬走，比不搬更难读。
 *
 * ## deps 里那七个「看起来多余」的东西是**必须的**
 *
 * `noteDocCacheKey` / `persistNoteDocLocal` / `noteDocStreams` /
 * `noteDocPresenceToReplay` / `noteDocStreamAllowed` / `hasNoteDocSubscription` /
 * `stopNoteDocStream` ——它们**定义在 `registerM1DesktopIpc` 闭包里**（不是模块级），
 * **搬过去就是副本**。
 *
 * 症状极具迷惑性：**typecheck 干净**，但每条通道 `ok: false`、
 * `store.get(cacheKey)` 恒为 null、`restored` 恒为空——
 * 主进程往自己的 Map 写，新模块读的是另一个 Map。
 *
 * **判据（从闭包抽依赖要分三类）**：
 * ① 纯值（schema、常量）→ 搬或 import 都行；
 * ② 可变状态（`let`、Map、Set）→ **传 getter/setter 或持有它的对象**；
 * ③ **闭包里的函数**（`() => …`）→ **必须作为依赖传**，它捕获了别的闭包变量。
 */

/**
 * M1 通道共用的入参底座。
 *
 * **手写一份，不要跟着搬**——`m1InputBase` 本身是被用到的顶层常量，
 * 跟着搬会**声明两次**。两份都是同一行 `{ meta: requestMetaSchema }`，
 * `requestMetaSchema` 来自 `@astella/shared`，所以是同一个对象。
 * 不从那边 import——它已经 import 这个模块，**会成环**。
 */
const m1InputBase = { meta: requestMetaSchema };

/** 这一族从 `registerM1DesktopIpc` 的闭包里拿到的全部东西。 */
export type NoteChannelDeps = {
  /** 闭包版 `installHandler`：**已经绑定了 options 与纪元取值器**（第①步）。 */
  channel: <TInput extends ParsedMeta, TOutput>(
    name: string,
    schema: InputSchema<TInput>,
    operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => TOutput | Promise<TOutput>,
    outputSchema?: z.ZodType<TOutput>,
  ) => void;
  /** 原样透传：这一族里有几条通道走的不是 `channel`。 */
  installHandler: <TInput extends ParsedMeta, TOutput>(
    name: string,
    schema: InputSchema<TInput>,
    options: unknown,
    operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => TOutput | Promise<TOutput>,
    getWorkspaceEpoch?: (output: TOutput) => number | undefined,
    outputSchema?: z.ZodType<TOutput>,
  ) => void;
  /**
   * 路由门与边界断言。**定成宽松签名**：`channel` 是泛型、路由门是 `(contract, route)`
   * （不是反过来）、`emit` 是 `(topic, payload)`——**手写一遍必然对不上**，
   * 而运行时完全正常。**真类型在调用点断言**（见 `desktop-ipc.ts` 的那处调用）。
   */
  requireM2Route: (...args: unknown[]) => void;
  requireAnyM2Route: (...args: unknown[]) => void;
  assertEpoch: (meta: { readonly workspaceEpoch?: number }, activeWorkspaceEpoch: number) => void;
  /** 服务端这一版的 M1 合同快照（只当不透明值传给路由门）。 */
  contract: unknown;
  /**
   * 工作区纪元——**getter，不是值**。它是闭包里的可变状态
   * （`authGetState` 之后才会变成 9）；按值传会在注册那一刻快照下来（= 0），
   * 于是每条通道的纪元都是 0，症状是 `stale_workspace` / 出参 `workspaceEpoch` 不对。
   */
  getActiveWorkspaceEpoch: () => number;
  /** 自由函数模块。 */
  ns_note: typeof ns_note;
  /** 网关本身。
   * ⚠️ **不要定成 `unknown`**——段内每一处 `gateway.gatewayTransport`
   *  都会变成类型错误（实测 110 条），而**运行时完全正常**。 */
  gateway: DesktopGateway;
  options: unknown;
  /** 往 renderer 发事件的出口。 */
  emit: (...args: unknown[]) => void;
  // ── ③ 类：定义在闭包里的函数与可变容器，**原样传引用** ──
  noteDocCacheKey: (noteId: string) => NoteDocCacheKey | null;
  persistNoteDocLocal: (noteId: string) => Promise<void>;
  noteDocStreams: Map<string, NoteDocStreamEntry>;
  noteDocPresenceToReplay: Map<string, unknown>;
  noteDocStreamAllowed: () => boolean;
  hasNoteDocSubscription: (noteId: string) => boolean;
  stopNoteDocStream: (noteId: string) => void;
  // ── ③ 类（2026-09-30 第 41 轮补齐）：`tsc` 不再被语法错掩盖之后，这五处才露出来 ──
  /** 当前空间标识。**定义在闭包里**，按值传会停在注册那一刻。 */
  getActiveWorkspaceId: () => string | null;
  /** 本机正文缓存。**闭包里的可变容器**——搬过去就是副本。 */
  noteDocCache: NoteDocCacheStore;
  /** 卡片生成的建连助手（闭包里的函数，捕获了别的闭包变量）。写侧只**登记**这一条
   *  run，真正开流由订阅表决定（见 `desktop-ipc.ts` 的 `trackCardGenerationRun`）。 */
  trackCardGenerationRun: (...args: unknown[]) => unknown;
  /** 动作能力门（闭包里的函数）。 */
  requireActionCapability: (...args: unknown[]) => Promise<void>;
  /** 工作区纪元——段内还有几处直接读它。**也要 getter**。 */
  activeWorkspaceEpoch: () => number;
};


/** 这一族专属的入参 / 出参 schema。跟着通道一起搬。 */
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
const reviewDeferInputSchema = z.strictObject({ ...m1InputBase, request: reviewDeferRequestV2Schema });
const reviewHoldObjectiveInputSchema = z.strictObject({ ...m1InputBase, request: objectiveHoldCommandV2Schema });
const reviewResumeObjectiveInputSchema = z.strictObject({ ...m1InputBase, request: objectiveResumeCommandV2Schema });
const reviewSubscriptionInputSchema = z.strictObject({ ...m1InputBase, request: reviewSubscriptionCommandV2Schema });
const noteListInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), trashed: z.boolean().optional() });
const noteCreateInputSchema = z.strictObject({ ...m1InputBase, request: desktopNoteCreateRequestSchema });
const noteIdInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
export const objectiveListInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), lifecycle: z.enum(["active", "archived", "superseded"]).optional(), noteId: uuidSchema.optional() });
const noteLearningRoundOpenInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
const noteLearningRoundCreateInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  drivingQuestion: z.string().trim().min(1).max(500).optional(),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema,
});
const noteLearningRoundReviseInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
  drivingQuestion: z.string().trim().min(1).max(500),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema,
});
const noteLearningRoundPersonalHistoryInputSchema = z.strictObject({
  ...m1InputBase,
  // 与按笔记那一条唯一的差别就是没有 noteId：这一页读的是"我"的所有轮次。
  limit: z.number().int().min(1).max(ROUND_HISTORY_MAX_LIMIT_V1).optional(),
  before: uuidSchema.optional(),
});
const noteLearningRoundHistoryInputSchema = z.strictObject({
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
const noteLearningRoundRouteInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
const noteLearningRoundTeachingInputSchema = z.strictObject({ ...m1InputBase, roundId: uuidSchema });
const noteLearningRoundPreparePracticeInputSchema = z.strictObject({
  ...m1InputBase, roundId: uuidSchema, expectedRevision: z.number().int().min(1),
});
const noteLearningRoundExplainInputSchema = z.strictObject({
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
const noteLearningRoundCloseInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
  // UI 上只有两种收尾：走完了 / 先到这里。system_failure 与 superseded 是服务端
  // 与"内容变了新开一轮"那两刀才会写的，不由这张表填。
  outcome: z.enum(["completed", "partial"]),
});
const noteLearningRoundReopenInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
});
const noteLearningRoundResumeInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
});
export const objectiveGetInputSchema = z.strictObject({ ...m1InputBase, objectiveId: uuidSchema });
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
const noteGetInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
const noteVersionsInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  currentVersionId: uuidSchema,
  limit: z.number().int().min(1).max(200).optional(),
});
const noteVersionRestoreInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  versionId: uuidSchema,
  baseVersionId: uuidSchema,
});
const noteImageUploadInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  request: noteImageUploadRequestV1Schema,
});
const noteSaveInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  request: desktopNoteSaveRequestV1Schema,
});
const noteDocStateInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
const noteDocSyncUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  // 本机文档产生的 yjs 增量（base64）。上限与下行帧同一处定义：两边各写一个数，
  // 迟早一边放行一边拒收。空增量界面就不该发（主进程仍会如实回 `unchanged`）。
  update: z.string().min(1).max(NOTE_DOC_UPDATE_MAX_CHARS),
});
const noteDocSyncTitleInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  // 与 `note.save` 那条同一个上限：标题只有一个来源长度，两侧各写一个数迟早一边
  // 放行一边拒收。空标题由界面自己挡在发起之前，这里仍按 min(1) 收口。
  title: z.string().min(1).max(200),
  titleSource: z.enum(["manual", "auto"]),
});
const noteSetShareInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  shareScope: z.enum(noteShareScopeValuesV1),
});
const noteDocPresenceInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  // 空串 = 我离开了这篇。上限与主进程里的 awareness 检查同一个数。
  state: z.string().max(NOTE_DOC_PRESENCE_MAX_CHARS),
});
const noteDocDraftSaveInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  // 与 `syncUpdate` 同一个上限：同一条增量走两条路，两侧不能各说一套。
  update: z.string().min(1).max(NOTE_DOC_UPDATE_MAX_CHARS),
});
const noteDocDraftNoteInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
const cardGenerationStartInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  request: desktopCreateCardGenerationRunRequestV2Schema,
});
const cardGenerationGetRunInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema });
const cardGenerationGetCandidatesInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema });
const cardGenerationReviewInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  request: desktopCandidateReviewRequestV2Schema,
});
const cardGenerationRevealInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  candidateId: uuidSchema,
  request: desktopRevealCandidateRequestV2Schema,
});
const cardGenerationExposureInputSchema = z.strictObject({
  ...m1InputBase,
  runId: uuidSchema,
  candidateId: uuidSchema,
  revision: positiveIntSchema,
});
const cardGenerationActivateInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  request: desktopCardGenerationActivationSelectionV1Schema,
});
const cardGenerationCancelInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema });
const cardGenerationRetryInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema });
const cardGenerationCloseInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  expectedReviewDraftRevision: positiveIntSchema,
});
const OBJECTIVE_REVIEW_ACTION_ROUTES = [
  "note.detail",
  "objective.detail",
  "objective.library",
] as const satisfies readonly DesktopRouteKindM2[];

/**
 * 注册这一族的通道。
 *
 * **只做一件事**：把 `deps` 解构成局部名，然后把通道照原样摆上去。
 * 通道体一个字没改——搬的是**位置**，不是**行为**。
 */
export function registerNoteChannels(deps: NoteChannelDeps): void {
  const {
    channel, installHandler, requireM2Route, requireAnyM2Route, assertEpoch,
    contract, getActiveWorkspaceEpoch, ns_note, gateway, options, emit,
    noteDocCacheKey, persistNoteDocLocal, noteDocStreams, noteDocPresenceToReplay,
    noteDocStreamAllowed, hasNoteDocSubscription, stopNoteDocStream,
    getActiveWorkspaceId, noteDocCache, trackCardGenerationRun, requireActionCapability,
    activeWorkspaceEpoch,
  } = deps;

installHandler(DESKTOP_IPC_CHANNELS.noteGet, noteGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const note = await ns_note.getNote(gateway.gatewayTransport, input.noteId, input.meta.requestId);
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
  }, noteImageUploadResultV1Schema)

channel(DESKTOP_IPC_CHANNELS.noteLearningRoundOpen, noteLearningRoundOpenInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getOpenNoteLearningRound(gateway.gatewayTransport, input.noteId, input.meta.requestId);
  }, noteLearningRoundViewV1Schema.nullable());

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundCreate, noteLearningRoundCreateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.createNoteLearningRound(gateway.gatewayTransport, {
      noteId: input.noteId,
      drivingQuestion: input.drivingQuestion,
      drivingQuestionSource: input.drivingQuestionSource,
    }, input.meta.requestId);
  }, noteLearningRoundV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundRevise, noteLearningRoundReviseInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.reviseNoteLearningRound(gateway.gatewayTransport, {
      roundId: input.roundId,
      expectedRevision: input.expectedRevision,
      drivingQuestion: input.drivingQuestion,
      drivingQuestionSource: input.drivingQuestionSource,
    }, input.meta.requestId);
  }, noteLearningRoundV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundPersonalHistory, noteLearningRoundPersonalHistoryInputSchema, async (_event, _window, input) => {
    // 路由与今日日志同一条：这块内容挂在**学习页**上，不在笔记页里。
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getMyLearningRoundHistory(gateway.gatewayTransport, 
      { limit: input.limit, before: input.before },
      input.meta.requestId,
    );
  }, noteLearningRoundPersonalHistoryPageV1Schema);

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

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundHistory, noteLearningRoundHistoryInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteLearningRoundHistory(gateway.gatewayTransport, 
      { noteId: input.noteId, limit: input.limit, before: input.before },
      input.meta.requestId,
    );
  }, noteLearningRoundHistoryPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundRoute, noteLearningRoundRouteInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteRouteCoverage(gateway.gatewayTransport, { noteId: input.noteId }, input.meta.requestId);
  }, noteRouteCoverageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundTeaching, noteLearningRoundTeachingInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteLearningRoundTeaching(gateway.gatewayTransport, input.roundId, input.meta.requestId);
  }, roundTeachingViewV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundPreparePractice, noteLearningRoundPreparePracticeInputSchema, async (_event, _window, input) => {
      requireM2Route(contract, "note.detail");
      assertEpoch(input.meta, getActiveWorkspaceEpoch());
      return ns_note.prepareNoteLearningRoundPractice(gateway.gatewayTransport, { roundId: input.roundId,
        expectedRevision: input.expectedRevision }, input.meta.requestId);
    }, roundTeachingViewV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundExplain, noteLearningRoundExplainInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.explainNoteLearningRoundTeaching(gateway.gatewayTransport, 
      { roundId: input.roundId, expectedRevision: input.expectedRevision, regenerate: input.regenerate === true,
        personalReflectionIds: input.personalReflectionIds ?? [] },
      input.meta.requestId,
    );
  }, roundTeachingViewV1Schema)

channel(DESKTOP_IPC_CHANNELS.noteLearningRoundClose, noteLearningRoundCloseInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.closeNoteLearningRound(gateway.gatewayTransport, {
      roundId: input.roundId,
      expectedRevision: input.expectedRevision,
      outcome: input.outcome,
    }, input.meta.requestId);
  }, noteLearningRoundV1Schema);

  // 恢复那一发的出口过的是教学面那一份合同（不是光一行轮次）：网关在推进之后接着读回
  // 服务端那一份，界面拿到的就是屏上要摆的那一块，两边不可能拼出两个版本。
  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundReopen, noteLearningRoundReopenInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.reopenNoteLearningRound(gateway.gatewayTransport, {
      roundId: input.roundId,
      expectedRevision: input.expectedRevision,
    }, input.meta.requestId);
  }, noteLearningRoundViewV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningRoundResume, noteLearningRoundResumeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.resumeNoteLearningRound(gateway.gatewayTransport, {
      roundId: input.roundId,
      expectedRevision: input.expectedRevision,
    }, input.meta.requestId);
  }, roundTeachingViewV1Schema)

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
    // 可写性这里一律不判：判据只在服务端那一处（WS 侧 `Authenticated("readonly")`、
    // HTTP 侧 `requireOwner`）。这里只决定"走哪条出口"。
    // 走哪条出口只判一次（同一个表达式），因为两条出口的判据必须是同一句话：连接被服务端
    // 认定可写，才并进那份文档（服务端由 WS 落盘）；否则取起点差分后走 HTTP，让同一句
    // `requireOwner` 给出答复。只读成员现在也建连（他要看到别人的改动），所以"有连接"
    // 本身不再等于"写得进去"。
    const stream = noteDocStreams.get(input.noteId);
    const onStream = Boolean(stream && stream.workspaceEpoch === activeWorkspaceEpoch() && stream.authorizedScope === "read-write");
    if (onStream && stream) {
      const update = stream.handle.applyLocal(input.update);
      // 本机没产生任何增量时不报"同步中"——那一次什么都没写，报成提交过就是在骗回执。
      return update === null
        ? { via: "unchanged", revision: null, savedAt: new Date().toISOString() }
        : { via: "stream", revision: null, savedAt: new Date().toISOString() };
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
    if (!stream || stream.workspaceEpoch !== activeWorkspaceEpoch()) return { shared: false as const };
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

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationStart, cardGenerationStartInputSchema, options,
    async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.start", input.meta.requestId);
    const request = desktopCreateCardGenerationRunRequestV2Schema.parse(input.request);
    const note = await ns_note.getNote(gateway.gatewayTransport, input.noteId, input.meta.requestId);
    if (note.currentVersionId !== request.noteVersionId) {
      throw new DesktopGatewayFailure("conflict", "resync_first");
    }
    const accepted = await ns_note.startCardGenerationRun(gateway.gatewayTransport, request, input.commandId, input.meta.requestId);
    trackCardGenerationRun(accepted.runId);
    return accepted;
  }, undefined, cardGenerationJobAcceptedV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationGetRun, cardGenerationGetRunInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.start", input.meta.requestId);
    const snapshot = await ns_note.getCardGenerationRun(gateway.gatewayTransport, input.runId, input.meta.requestId);
    trackCardGenerationRun(snapshot.runId);
    return snapshot;
  }, undefined, cardGenerationRunSnapshotV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationGetCandidates, cardGenerationGetCandidatesInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.start", input.meta.requestId);
    trackCardGenerationRun(input.runId);
    return ns_note.getCardGenerationCandidates(gateway.gatewayTransport, input.runId, input.meta.requestId);
  }, undefined, cardGenerationCandidateListV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationReview, cardGenerationReviewInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.review", input.meta.requestId);
    const request = desktopCandidateReviewRequestV2Schema.parse(input.request);
    if (request.runId !== input.runId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    trackCardGenerationRun(input.runId);
    return ns_note.reviewCardGeneration(gateway.gatewayTransport, input.runId, request, input.commandId, input.meta.requestId);
  }, undefined, cardGenerationReviewResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationReveal, cardGenerationRevealInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.reveal", input.meta.requestId);
    const request = desktopRevealCandidateRequestV2Schema.parse(input.request);
    if (request.candidateId !== input.candidateId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    trackCardGenerationRun(input.runId);
    return ns_note.revealCardGenerationCandidate(gateway.gatewayTransport, input.runId, input.candidateId, request, input.commandId, input.meta.requestId);
  }, undefined, candidateRevealV2Schema);

  channel(DESKTOP_IPC_CHANNELS.noteCardGenerationLatestRun, noteIdInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.start", input.meta.requestId);
    return ns_note.getLatestCardGenerationRun(gateway.gatewayTransport, input.noteId, input.meta.requestId);
  }, cardGenerationRunSnapshotV1Schema.nullable());

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationExposure, cardGenerationExposureInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.reveal", input.meta.requestId);
    return ns_note.getCardGenerationExposure(gateway.gatewayTransport, input.runId, input.candidateId, input.revision, input.meta.requestId);
  }, undefined, cardGenerationExposureEligibilityV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationActivate, cardGenerationActivateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.activate", input.meta.requestId);
    const request = desktopCardGenerationActivationSelectionV1Schema.parse(input.request);
    if (request.runId !== input.runId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    trackCardGenerationRun(input.runId);
    return ns_note.activateCardGeneration(gateway.gatewayTransport, input.runId, request, input.commandId, input.meta.requestId);
  }, undefined, cardActivationReceiptDesktopV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationCancel, cardGenerationCancelInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.cancel", input.meta.requestId);
    trackCardGenerationRun(input.runId);
    return ns_note.cancelCardGeneration(gateway.gatewayTransport, input.runId, input.commandId, input.meta.requestId);
  }, undefined, cardGenerationCancelResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationRetry, cardGenerationRetryInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.retry", input.meta.requestId);
    // 重试会在同一 run 上重新出版本与候选，流必须跟着这条 run 走（与 cancel 同理）。
    trackCardGenerationRun(input.runId);
    return ns_note.retryCardGeneration(gateway.gatewayTransport, input.runId, input.commandId, input.meta.requestId);
  }, undefined, cardGenerationRetryResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationClose, cardGenerationCloseInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await requireActionCapability("card_generation.close", input.meta.requestId);
    trackCardGenerationRun(input.runId);
    return ns_note.closeCardGeneration(gateway.gatewayTransport, input.runId, input.expectedReviewDraftRevision, input.commandId, input.meta.requestId);
  }, undefined, cardGenerationCloseResultV1Schema)

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
}
