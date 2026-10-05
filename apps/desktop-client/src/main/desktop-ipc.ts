import {
  setPersonalRelationDecisionV2ResultSchema,
  setPersonalRelationDecisionV2Schema,
} from "@ailearn/shared/personal-relation-decision-rules-v2";
import * as ns_source from "./desktop-gateway-ns-source";
import { registerRestChannels } from "./desktop-ipc-rest";
import { registerSourceChannels, noteListInputSchema, noteCreateInputSchema, noteGetInputSchema, noteVersionsInputSchema, noteVersionRestoreInputSchema, noteImageUploadInputSchema } from "./desktop-ipc-source";
import { registerLearningChannels, shellOpenExternalInputSchema, windowThemeInputSchema, subscribeInputSchema, unsubscribeInputSchema, titlebarThemeOutputSchema, focusOutputSchema, subscriptionOutputSchema, closedSubscriptionOutputSchema, activityGetTodayInputSchema, statsGetOverviewAllInputSchema, assessmentDisputeGetInputSchema, assessmentDisputeOpenInputSchema, assessmentDisputeSupplementInputSchema, assessmentDisputeCloseInputSchema, assessmentDisputeSupplementResultV2Schema, noteIdInputSchema, noteLearningRoundOpenInputSchema, noteLearningRoundCreateInputSchema, noteLearningRoundReviseInputSchema, noteLearningRoundPersonalHistoryInputSchema, noteLearningRoundHistoryInputSchema, noteLearningRoundRouteInputSchema, noteLearningRoundTeachingInputSchema, noteLearningRoundPreparePracticeInputSchema, noteLearningRoundExplainInputSchema, artifactEnsureInputSchema, artifactEnsureResultSchema, noteLearningRoundCloseInputSchema, noteLearningRoundReopenInputSchema, noteLearningRoundResumeInputSchema, setPersonalRelationDecisionInputSchema, noteDeepeningInputSchema, searchGlobalInputSchema, noteSaveInputSchema, noteDocStateInputSchema, noteDocSyncUpdateInputSchema, noteDocSyncTitleInputSchema, noteSetShareInputSchema, noteDocPresenceInputSchema, noteDocDraftSaveInputSchema, noteDocDraftNoteInputSchema, cardGenerationStartInputSchema, cardGenerationGetRunInputSchema, cardGenerationGetCandidatesInputSchema, cardGenerationReviewInputSchema, cardGenerationRevealInputSchema, cardGenerationExposureInputSchema, cardGenerationActivateInputSchema, cardGenerationCancelInputSchema, cardGenerationRetryInputSchema, cardGenerationCloseInputSchema } from "./desktop-ipc-learning";
import { registerAuthChannels } from "./desktop-ipc-auth";
import { createRunStreamLedger, reconcileRunStreams, stopRunStreams, type RunStreamPorts } from "./desktop-ipc-run-streams";
import { registerWorkspaceChannels, authUpdateProfileInputSchema, authAvatarUploadInputSchema, authAvatarGetInputSchema, authLeaveWorkspaceInputSchema, inviteCreateInputSchema, inviteRevokeInputSchema, memberRemoveInputSchema, revokeOutputSchema, memberRemoveOutputSchema } from "./desktop-ipc-workspace";
import { registerCompanionChannels, runtimeInputSchema, companionMemoryIdInputSchema, sourceListInputSchema, sourceCreateInputSchema, sourceGetInputSchema, sourceNotesInputSchema, sourceUpdateInputSchema, sourceCreateNoteInputSchema, sourceArchiveInputSchema, sourceReparseInputSchema, sourceRestoreInputSchema, sourceImageGetInputSchema } from "./desktop-ipc-companion";
import * as ns_note from "./desktop-gateway-ns-note";
import * as ns_companion from "./desktop-gateway-ns-companion";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
} from "./desktop-update";
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
  clipboardWriteTextRequestV1Schema,
  clipboardWriteTextResultV1Schema,
  isWebLinkUrl,
  shellOpenExternalRequestV1Schema,
  shellOpenExternalResultV1Schema,
  updateGetStateInputV1Schema,
  updateGetStateResultV1Schema,
  updateCheckInputV1Schema,
  updateDownloadInputV1Schema,
  updateInstallInputV1Schema,
  updateStateV1Schema,
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
// 跨空间统计合同：输出校验器与网关共用同一份形状，渲染层不另抄一遍。
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
// 伴星聊天发送链路（2026-09-18）：建/复用 dialogue、发 turn、拉消息。
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
// 站内图片字节通道：来源正文里的 `/api/uploads/…` 由 main 代取，
// 渲染层只拿 base64 转 blob URL（它的 origin 够不到 API 源）。
import {
  sourceImageGetRequestV1Schema,
  sourceImageGetResultV1Schema,
} from "@ailearn/shared/source-image-contracts";
// 笔记图片写入通道：编辑器里的图由 main 送到 `POST /uploads/images`，渲染层拿回
// 站内地址写进正文；读取那一半仍走上面的字节通道。
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
export { FormalAssessmentGuard };
import { matchesLearningRunReturnRoute, recoverPendingReturnMarker, resolveLearningRunReturn, routeForLearningRunReturn } from "./learning-run-return-resolver";
import { MemoryPendingReturnMarkerStore, type PendingReturnMarkerStore } from "./pending-return-marker-store";
export type { PendingReturnMarkerStore };
import {
  MemoryNoteDocCacheStore,
  type NoteDocCacheEntryV1,
  type NoteDocCacheKey,
  type NoteDocCacheStore,
} from "./note-doc-cache-store.ts";
export type { NoteDocCacheStore };
import { ensureArtifactStored } from "./artifact-store";
import { VoiceAsrModelStore } from "./voice-asr-model-store";
import { voiceAsrModelMountUrl } from "./voice-asr-model-route";
import { voiceAsrModelSnapshotV1Schema } from "@ailearn/shared/voice-asr-model-contracts";
import type { WindowStateSnapshot } from "../shared/window-state";

type WindowResolver = (contents: WebContents, sourceUrl: string) => BrowserWindow | null;

export type DesktopIpcRegistrationOptions = {
  readonly guidanceAudioCache?: import("./companion-guidance-audio-cache").CompanionGuidanceAudioCache;
  readonly resolveWindow: WindowResolver;
  readonly getWindowState: (window: BrowserWindow) => WindowStateSnapshot;
  readonly setTitlebarTheme: (window: BrowserWindow, theme: "day" | "night") => boolean;
  readonly getReducedMotion?: () => boolean;
  readonly gateway?: DesktopGateway;
  readonly credentials?: SessionCredentialStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly formalAssessmentGuard?: FormalAssessmentGuard;
  readonly pendingReturnMarkerStore?: PendingReturnMarkerStore;
  /** 本机那份笔记文档的落盘口（决定 7：断网可编辑要能跨过重启）。 */
  readonly noteDocCache?: NoteDocCacheStore;
  /**
   * 动态产物的落盘根目录（39d W4-6 刀五）：`artifact-store.ts` 会在其下拼
   * `artifacts/<id>.html`——必须与 `index.ts` 读侧 `artifactSourcePath` 同一个目录。
   *
   * 传**函数**而不是值：`desktop-ipc` 不 import Electron 的 `app`（通道覆盖那份测试的
   * 替身里没有 `app.getPath`，模块加载期碰它就会红），生产由 `index.ts` 给
   * `() => app.getPath("userData")`，测试给临时目录。
   */
  readonly artifactUserDataDir?: () => string;
  /**
   * 本地语音识别模型的仓库（读状态 / 下载 / 中止 / 移除）。
   *
   * 缺注入不是"功能降级"，而是接线错误：这四条通道当场喊 `configuration_error`。
   * 模型不进安装包，所以**它必须是用户点过下载之后才存在**的那一份**——主进程
   * 读不到别处去拿一个"应该有"的模型，那正是把 239 MB 偷偷塞回安装包的老路。
   */
  readonly voiceAsrModelStore?: VoiceAsrModelStore;
};

const m1InputBase = { meta: requestMetaSchema };
const cancelInputSchema = z.strictObject({ ...m1InputBase, requestId: requestIdSchema });
const navigationResolveInputSchema = z.strictObject({ ...m1InputBase, route: desktopRouteSchema, learningRunId: uuidSchema.optional() });
const navigationGoInputSchema = z.strictObject({
  ...m1InputBase,
  route: desktopRouteSchema,
  entryKind: navigationReasonSchema,
  learningRunId: uuidSchema.optional(),
});
const cancelOutputSchema = z.strictObject({ cancelled: z.literal(true) });
/** 一条笔记的活连接；`workspaceEpoch` 用来在切空间时识别"这条已经不作数"。 */
export type NoteDocStreamEntry = {
  handle: NoteDocWatchHandle;
  workspaceEpoch: number;
  /**
   * 服务端给的读写范围，`null` = 还没收到状态帧。**写入只认 `read-write`**：
   * 把只读成员（或服务端还没开口）的提交并进本机文档、再回一句 `via:"stream"`，
   * 就是"界面以为写进去了、服务端其实没落盘"那一类假状态。判据仍然只有服务端那一处，
   * 这里只是不再把它的答复猜成正面。
   */
  authorizedScope: "read-write" | "readonly" | null;
};

export type InputSchema<T> = z.ZodType<T>;
export type ParsedMeta = { readonly meta: RequestMetaV1 };

type NavigationState = {
  entries: NavigationEntryV1[];
  revision: number;
};

type SubscriptionRecord = {
  readonly window: BrowserWindow;
  readonly topic: SubscriptionTopicM2;
};

type M2SubscriptionEvent = GatewayEventPayloadM2;

const navigationByWindow = new WeakMap<BrowserWindow, NavigationState>();
let registrationComplete = false;

function generatedOpaqueId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("base64url")}`;
}
function fallbackMeta(): RequestMetaV1 {
  const now = new Date().toISOString();
  return {
    version: 1,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    requestId: generatedOpaqueId("invalid-request"),
    correlationId: generatedOpaqueId("invalid-correlation"),
    clientStartedAt: now,
  };
}

function readMeta(value: unknown): RequestMetaV1 {
  if (typeof value !== "object" || value === null || !("meta" in value)) return fallbackMeta();
  const parsed = requestMetaSchema.safeParse(value.meta);
  return parsed.success ? parsed.data : fallbackMeta();
}

function errorRetryFor(code: GatewayErrorCode): "never" | "user_action" | "safe_retry" | "resync_first" {
  if (code === "api_unavailable" || code === "network_timeout" || code === "rate_limited") return "safe_retry";
  if (code === "result_unknown" || code === "stale_workspace") return "resync_first";
  if (
    code === "configuration_error" ||
    code === "api_untrusted" ||
    code === "unsupported_contract" ||
    code === "auth_required" ||
    code === "reauth_required"
  ) return "user_action";
  return "never";
}

function errorResult<T>(
  meta: RequestMetaV1,
  code: GatewayErrorCode,
  options: {
    readonly retry?: "never" | "user_action" | "safe_retry" | "resync_first";
    readonly httpStatus?: number;
    readonly retryAfter?: string;
    readonly localEffect?: "none" | "credential_cleared" | "request_cancelled";
    readonly workspaceEpoch?: number;
  } = {},
): GatewayResultV1<T> {
  const error = gatewayErrorSchema.parse({
    code,
    safeMessageKey: `error.${code}`,
    retry: options.retry ?? errorRetryFor(code),
    ...(options.httpStatus !== undefined && options.httpStatus >= 400 && options.httpStatus <= 499
      ? { httpStatus: options.httpStatus }
      : {}),
    ...(options.retryAfter ? { retryAfter: options.retryAfter } : {}),
    ...(options.localEffect ? { localEffect: options.localEffect } : {}),
  });
  return {
    version: 1,
    ok: false,
    error,
    requestId: meta.requestId,
    correlationId: meta.correlationId,
    schemaRevision: DESKTOP_IPC_SCHEMA_REVISION,
    ...(options.workspaceEpoch !== undefined ? { workspaceEpoch: options.workspaceEpoch } : {}),
  };
}

function okResult<T>(meta: RequestMetaV1, data: T, workspaceEpoch?: number): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: meta.requestId,
    correlationId: meta.correlationId,
    schemaRevision: DESKTOP_IPC_SCHEMA_REVISION,
    ...(workspaceEpoch !== undefined ? { workspaceEpoch } : {}),
  };
}

function safeWorkspaceEpoch(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("workspaceEpoch" in value)) return undefined;
  const parsed = z.number().int().min(1).safeParse(value.workspaceEpoch);
  return parsed.success ? parsed.data : undefined;
}

function mapFailure<T>(meta: RequestMetaV1, error: unknown, workspaceEpoch?: number): GatewayResultV1<T> {
  if (error instanceof DesktopGatewayFailure) {
    return errorResult(meta, error.code, {
      retry: error.retry,
      httpStatus: error.httpStatus,
      retryAfter: error.retryAfter,
      localEffect: error.localEffect,
      workspaceEpoch,
    });
  }
  if (error instanceof z.ZodError) {
    return errorResult(meta, "unsupported_contract", { workspaceEpoch });
  }
  return errorResult(meta, "safe_internal_error", { workspaceEpoch });
}

function isM1Route(route: DesktopRouteV1): route is Extract<DesktopRouteV1, { kind: "auth.login" | "auth.register" }> {
  return route.kind === "auth.login" || route.kind === "auth.register";
}

function requireM1Route(route: DesktopRouteV1): void {
  if (!isM1Route(route)) throw new DesktopGatewayFailure("route_not_available", "user_action");
}

function navigationEntry(route: DesktopRouteV1, meta: RequestMetaV1, entryKind: NavigationEntryV1["entryKind"]): NavigationEntryV1 {
  requireM1Route(route);
  const gateRoute = route as Extract<DesktopRouteV1, { kind: "auth.login" | "auth.register" }>;
  return {
    version: 1,
    scope: "gate",
    historyKey: `gate-${route.kind}`,
    route: gateRoute,
    entryKind,
    correlationId: meta.correlationId,
  };
}

function navigationState(window: BrowserWindow, meta: RequestMetaV1): NavigationState {
  const existing = navigationByWindow.get(window);
  if (existing) return existing;
  const state: NavigationState = {
    entries: [navigationEntry({ kind: "auth.login" }, meta, "startup")],
    revision: 0,
  };
  navigationByWindow.set(window, state);
  return state;
}

function navigationSnapshot(state: NavigationState): NavigationSnapshotV1 {
  return {
    version: 1,
    current: state.entries[state.entries.length - 1],
    stackRevision: state.revision,
    canBack: state.entries.length > 1,
  };
}

function contractSnapshot(gateway: DesktopGateway, env: NodeJS.ProcessEnv): DesktopContractSnapshotV1 {
  const deployment = gateway.getDeploymentConfig();
  const domainSchemaRevision = deployment?.expectedDomainSchemaRevision ?? env.AILEARN_DOMAIN_SCHEMA_REVISION?.trim() ?? "unconfigured";
  const deploymentConfigRevision = deployment?.configRevision ?? env.DESKTOP_DEPLOYMENT_CONFIG_REVISION?.trim() ?? "desktop-dev-config-v1";
  return desktopContractSnapshotSchema.parse({
    version: 1,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision,
    deploymentConfigRevision,
    namespaces: [...desktopNamespaceM2Values],
    enabledRoutes: [...desktopRouteKindM2Values],
  });
}

function asWindowState(snapshot: WindowStateSnapshot): WindowStateSnapshotV1 {
  return windowStateSnapshotV1Schema.parse({ version: 1, state: snapshot.state, revision: snapshot.revision });
}

function readPayload<T>(input: unknown, schema: InputSchema<T>): { ok: true; value: T } | { ok: false; meta: RequestMetaV1 } {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, meta: readMeta(input) };
}

export function installHandler<TInput extends ParsedMeta, TOutput>(
  channel: string,
  schema: InputSchema<TInput>,
  options: DesktopIpcRegistrationOptions,
  operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => Promise<TOutput> | TOutput,
  getWorkspaceEpoch?: (output: TOutput) => number | undefined,
  outputSchema?: z.ZodType<TOutput>,
): void {
  ipcMain.handle(channel, async (event, rawInput: unknown): Promise<GatewayResultV1<TOutput>> => {
    const parsed = readPayload(rawInput, schema);
    if (!parsed.ok) return errorResult<TOutput>(parsed.meta, "invalid_request");

    const window = options.resolveWindow(event.sender, event.senderFrame?.url ?? "");
    if (!window) return errorResult<TOutput>(parsed.value.meta, "invalid_request");

    try {
      const output = await operation(event, window, parsed.value);
      const outputValidation = outputSchema?.safeParse(output);
      if (outputValidation && !outputValidation.success) {
        throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      }
      const validatedOutput = outputValidation ? outputValidation.data : output;
      return okResult(parsed.value.meta, validatedOutput, getWorkspaceEpoch?.(validatedOutput));
    } catch (error) {
      return mapFailure<TOutput>(parsed.value.meta, error, getWorkspaceEpoch?.(undefined as TOutput));
    }
  });
}

/**
 * 空间边界守卫，**fail closed**。
 *
 * 原实现是 `meta.workspaceEpoch !== undefined && meta.workspaceEpoch !== active`，
 * 于是"调用方忘了带 epoch"= 直接放行。而 `createRequestMeta()` 不传参时就不带
 * epoch（epoch 为 0 时也会被丢掉），所以漏带是默认状态而非例外：批量 URL 采集在
 * 循环中途切空间，剩余条目会带着**新空间**的凭据（网关只持一个 `this.token`）
 * 静默落进新空间。缺 epoch 现在一律按边界失效处理。
 *
 * 只有三类通道走 `assertEpochBoundaryExempt`：握手前后（此时还没有 epoch 可带）、
 * 本身用于改变边界的（切空间/加入/退出）、以及与工作区无关的原生与窗口面。
 */
function assertEpoch(meta: RequestMetaV1, activeWorkspaceEpoch: number): void {
  if (meta.workspaceEpoch === undefined || meta.workspaceEpoch !== activeWorkspaceEpoch) {
    throw new DesktopGatewayFailure("stale_workspace", "resync_first");
  }
}

/**
 * 边界豁免：仍校验"带了就必须对"，但不带不拦。新增调用点必须在这里登记理由，
 * 否则应当走 `assertEpoch`。
 */
function assertEpochBoundaryExempt(meta: RequestMetaV1, activeWorkspaceEpoch: number): void {
  if (meta.workspaceEpoch !== undefined && meta.workspaceEpoch !== activeWorkspaceEpoch) {
    throw new DesktopGatewayFailure("stale_workspace", "resync_first");
  }
}

export function requireM2Route(contract: DesktopContractSnapshotV1, route: DesktopRouteKindM2): void {
  if (!contract.enabledRoutes.includes(route)) throw new DesktopGatewayFailure("route_not_available", "user_action");
}

/**
 * 同一份数据会在多个面上出现时的路由门控（如来源图片同时出现在来源详情和
 * 笔记阅读页）。只要调用方所在的面可达即可——按单一路由收口会把另一个面上
 * 的合法读取挡在门外。
 */
export function requireAnyM2Route(contract: DesktopContractSnapshotV1, routes: readonly DesktopRouteKindM2[]): void {
  if (!routes.some((route) => contract.enabledRoutes.includes(route))) {
    throw new DesktopGatewayFailure("route_not_available", "user_action");
  }
}

export function registerM1DesktopIpc(options: DesktopIpcRegistrationOptions): AILearnDesktopApiM2["contract"] {
  if (registrationComplete) throw new Error("M1 desktop IPC has already been registered");
  registrationComplete = true;

  const gateway = options.gateway ?? new DesktopGateway(options.env, {
    credentials: options.credentials ?? createSessionCredentialStore(),
    guidanceAudioCache: options.guidanceAudioCache,
  });
  const env = options.env ?? process.env;
  const contract = contractSnapshot(gateway, env);

  /**
   * 纪元取值器。**原来 148 条通道各写一遍** `() => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined`
   * ——同一个常量表达式抄了 148 次。抄一次就够；语义在 `activeWorkspaceEpoch` 的定义处。
   */
  const currentWorkspaceEpoch = (): number | undefined =>
    activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined;

  /**
   * `installHandler` 的闭包版：**绑定 `options` 与纪元取值器**。
   *
   * 为什么要这一层：原来每条通道都要写满
   * `installHandler(频道, 入参 schema, options, 处理函数, () => …, 出参 schema)`。
   * **`options` 与那个纪元箭头对 218 条通道全是同一个**——写出来只是噪音，
   * 噪音会让「这条通道和别的有什么不同」这件事看不见。
   * 收进这一层之后，**一条通道里剩下的就只有它自己的差异**。
   */
  const channel = <TInput extends ParsedMeta, TOutput>(
    name: string,
    schema: InputSchema<TInput>,
    // 返回 `TOutput | Promise<TOutput>`：有些通道的处理函数不是 `async`（直接返回结果），
    // `installHandler` 那边本来就 `await`，这里不该把它们挡在类型之外。
    operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => TOutput | Promise<TOutput>,
    outputSchema?: z.ZodType<TOutput>,
  ): void => installHandler(name, schema, options, operation as (
    event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput,
  ) => Promise<TOutput>, currentWorkspaceEpoch, outputSchema);
  const formalAssessmentGuard = options.formalAssessmentGuard ?? new FormalAssessmentGuard();
  const packagedLearningRunResponseLossOperations = new Set<"draft" | "submit" | "action">();
  for (const operation of (env.AILEARN_PACKAGED_LEARNING_RUN_RESPONSE_LOSS ?? "").split(",").map((value) => value.trim())) {
    if (operation === "draft" || operation === "submit" || operation === "action") packagedLearningRunResponseLossOperations.add(operation);
  }
  const packagedLearningRunResponseLossInjected = new Set<"draft" | "submit" | "action">();
  const maybeInjectPackagedLearningRunResponseLoss = (operation: "draft" | "submit" | "action"): void => {
    if (
      env.AILEARN_PACKAGED_EVIDENCE !== "1"
      || !packagedLearningRunResponseLossOperations.has(operation)
      || packagedLearningRunResponseLossInjected.has(operation)
    ) return;
    packagedLearningRunResponseLossInjected.add(operation);
    // Evidence-only seam: the server mutation has already completed and the
    // main process has synchronized its guard/stream state, but the renderer
    // receives the same typed result-unknown contract as a lost IPC response.
    // It is never exposed through preload and is disabled for normal builds.
    throw new DesktopGatewayFailure("result_unknown", "resync_first");
  };
  if (env.AILEARN_PACKAGED_EVIDENCE === "1") {
    // This is a main-process-only observation seam for the packaged evidence
    // harness. It is intentionally absent from preload and renderer APIs so
    // formal sensitivity cannot be queried or influenced by page code.
    const evidenceGlobal = globalThis as typeof globalThis & {
      __ailearnFormalAssessmentGuardEvidence?: {
        getSnapshot: () => ReturnType<FormalAssessmentGuard["getSnapshot"]>;
        authorizeCompanionDelivery: (kind: CompanionDeliveryKind) => ReturnType<FormalAssessmentGuard["authorizeCompanionDelivery"]>;
      };
    };
    evidenceGlobal.__ailearnFormalAssessmentGuardEvidence = {
      getSnapshot: () => formalAssessmentGuard.getSnapshot(),
      authorizeCompanionDelivery: (kind) => formalAssessmentGuard.authorizeCompanionDelivery(kind),
    };
  }
  const pendingReturnMarkerStore = options.pendingReturnMarkerStore ?? new MemoryPendingReturnMarkerStore();
  const noteDocCache = options.noteDocCache ?? new MemoryNoteDocCacheStore();
  /**
   * 本机那份文档的键。身份不全时返回 null，调用方一律"不读也不写"——
   * 缓存的边界就是身份的边界：没有 subjectId 的一份缓存，等于给下一个人留着
   * 上一个人的私有笔记正文。
   */
  const noteDocCacheKey = (noteId: string): NoteDocCacheKey | null =>
    activeSubjectId && activeWorkspaceId ? { subjectId: activeSubjectId, workspaceId: activeWorkspaceId, noteId } : null;

  const persistNoteDocLocal = async (noteId: string): Promise<void> => {
    const key = noteDocCacheKey(noteId);
    if (!key) return;
    const snapshot = ns_note.noteDocLocalSnapshot(gateway.gatewayTransport, noteId);
    if (!snapshot) return;
    await noteDocCache.set(key, { ...snapshot, epochAtRest: activeWorkspaceEpoch, updatedAt: new Date().toISOString() });
  };
  /**
   * 产物往哪个 userData 写（39d W4-6 刀五）。缺注入就是接线错误：当场喊
   * `configuration_error`，不许让"没落盘"在界面上装成"已经在了"。
   */
  const artifactUserDataDir = (): string => {
    const resolveUserDataDir = options.artifactUserDataDir;
    if (!resolveUserDataDir) throw new DesktopGatewayFailure("configuration_error", "user_action");
    return resolveUserDataDir();
  };
  let activeWorkspaceEpoch = 0;
  let activeSubjectId: string | null = null;
  let activeWorkspaceId: string | null = null;
  let eventRevision = 0;
  const subscriptions = new Map<string, SubscriptionRecord>();
  // run 事件流的账本与规矩在 `desktop-ipc-run-streams.ts`；这里只把它接到闭包上。
  const learningRunStreams = createRunStreamLedger();
  const cardGenerationStreams = createRunStreamLedger();
  /** 伴星会话事件流：conversationId → 停止函数（每个会话至多一条）。 */
  const companionChatStreams = new Map<string, () => void>();
  /**
   * 笔记协同流：noteId → 该笔记的连接句柄（每篇至多一条，多个窗口共用）。
   *
   * 与 SSE 那几条不同，这里存的不是"停止函数"而是句柄：界面上行的增量要交给**同一条**
   * 连接的文档，才能与订阅者共用一份 CRDT 状态。
   */
  const noteDocStreams = new Map<string, NoteDocStreamEntry>();
  /**
   * 订阅回执比连接早：`ensureNoteDocStream` 是异步建连的，界面那声"我也开着这一篇"
   * 几乎总抢在句柄就位之前到达，当场丢掉就成了"我这侧一切正常、对端永远等不到我"
   * （2026-09-22 两个真客户端实测）。所以最近一次报的状态先记在这儿，连接就位时补交。
   */
  const noteDocPresenceToReplay = new Map<string, string>();
  /** 门控判据（决定 7b）：当前空间的类型与本人角色，由 `rememberSession` 实时更新。 */
  let activeWorkspaceKind: "personal" | "collaborative" | null = null;
  let activeWorkspaceRole: "owner" | "member" | null = null;
  let stopCompanionAccountEvents: (() => void) | null = null;
  let stopCompanionInboxEvents: (() => void) | null = null;
  /**
   * 收件箱事件**合流广播**。inbox SSE 在连接时会把未 ACK 的积压**全量重放**
   * （`after=0`，实测 26 条），逐条 emit 会让渲染层在同一瞬间发起同等次数的
   * 投影重取——而主动念头气泡已经把投影刷新当成自己的触发源（方案 29 §9.15）。
   * 一段突发只广播一次，带最大的那个 sequence。
   */
  let companionInboxBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let companionInboxBroadcastSeq = 0;
  let companionInboxCursor = 0;
  /** 伴星两条常连接的身份：重开时要按同一个 account epoch、从同一格 inbox 游标续读。 */
  type CompanionStreamContext = {
    readonly generation: number;
    readonly workspaceEpoch: number;
    readonly accountEpoch: number;
  };
  let companionStreamContext: CompanionStreamContext | null = null;
  let companionStreamsPaused = false;
  let companionRuntimeFenceTimer: ReturnType<typeof setInterval> | null = null;
  let companionLifecycleGeneration = 0;
  let companionLifecycleWorkspaceEpoch = 0;
  /**
   * 已经就"账号级关闭"下过结论的空间纪元。
   *
   * 关闭时不建任何连接，`stopCompanionAccountEvents` 就一直是 null，上面那道
   * "已经在跑"的早退判据因此永远不成立——而 `authGetState` 每次读会话都会再调一次
   * 生命周期，于是每读一次会话就重发一条 `snapshot_invalidated`；门禁把它当成会话
   * 失效 → 再读会话 → 再发一条，自己喂自己，永远不停（F01 的第二因素）。关闭是**按
   * 空间纪元**得出的结论，同一个纪元只报一次。
   */
  let companionLifecycleDisabledEpoch = 0;
  const windowLifecycleBound = new WeakSet<BrowserWindow>();

  const clearSubscriptionsForWindow = (window: BrowserWindow): void => {
    for (const [subscriptionId, subscription] of subscriptions) {
      if (subscription.window === window) subscriptions.delete(subscriptionId);
    }
  };

  const hasLearningRunSubscription = (): boolean => {
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind === "learningRun") return true;
    }
    return false;
  };

  /**
   * 此刻**真的有订阅方**的 run id（L9）。
   *
   * `trackedLearningRunIds` / `trackedCardGenerationRunIds` 以前只加不减（只有退出
   * 登录 / 切空间那几处 `clear()`），而每一次 `subscriptions.subscribe` 都会对集合里
   * **每一个** id 开一条 SSE。于是"这一趟运行里看过多少个 run"直接等于"对本地 API 挂
   * 多少条常连接"，而且其中绝大部分已经没有任何人在看了。改成以订阅表为准：
   * 没订阅者的 run 既不再开流，也已开出的流就地停掉。
   */
  const subscribedRunIds = (kind: "learningRun" | "cardGeneration"): Set<string> => {
    const runIds = new Set<string>();
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind === kind) runIds.add(subscription.topic.runId);
    }
    return runIds;
  };

  const stopLearningRunStreams = (): void => stopRunStreams(learningRunStreams);

  const hasCardGenerationSubscription = (): boolean => {
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind === "cardGeneration") return true;
    }
    return false;
  };

  const stopCardGenerationStreams = (): void => stopRunStreams(cardGenerationStreams);

  const hasCompanionChatSubscription = (conversationId?: string): boolean => {
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind !== "companionChat") continue;
      if (conversationId === undefined || subscription.topic.conversationId === conversationId) return true;
    }
    return false;
  };

  const stopCompanionChatStreams = (): void => {
    for (const stop of companionChatStreams.values()) stop();
    companionChatStreams.clear();
  };

  const stopCompanionChatStream = (conversationId: string): void => {
    const stop = companionChatStreams.get(conversationId);
    if (!stop) return;
    companionChatStreams.delete(conversationId);
    stop();
  };

  const stopCompanionLifecycle = (): void => {
    const revokeBridge = gateway.companionBridge?.clearCompanionBridgeContext?.();
    if (revokeBridge) void revokeBridge.catch(() => undefined);
    if (companionInboxBroadcastTimer) clearTimeout(companionInboxBroadcastTimer);
    companionInboxBroadcastTimer = null;
    companionInboxBroadcastSeq = 0;
    companionLifecycleGeneration += 1;
    companionLifecycleWorkspaceEpoch = 0;
    companionLifecycleDisabledEpoch = 0;
    companionStreamContext = null;
    companionStreamsPaused = false;
    stopCompanionAccountEvents?.();
    stopCompanionAccountEvents = null;
    stopCompanionInboxEvents?.();
    stopCompanionInboxEvents = null;
    companionInboxCursor = 0;
    if (companionRuntimeFenceTimer) clearInterval(companionRuntimeFenceTimer);
    companionRuntimeFenceTimer = null;
    gateway.companionBridge?.clearCompanionRuntimeState?.();
  };

  /**
   * M16：所有窗口都不在前台时，把伴星那两条常连接收掉。
   *
   * 只收 SSE，**不收 60 秒一次的 runtime fence 续约**：`renewCompanionRuntimeFence`
   * 是服务端判断"她此刻在不在"的唯一来源，停掉它就等于把"窗口最小化"当成"用户离线"——
   * 那是伴星在场语义的产品变更，不是一条性能项该顺带决定的。
   *
   * 读不到窗口清单时一律按"没隐藏"处理。这不是防御性摆设：任何一次取窗口失败
   * （窗口正在销毁、平台差异、测试替身没有这个 API）都不该让伴星更新整趟不再到达。
   */
  const allCompanionWindowsHidden = (): boolean => {
    try {
      const allWindows = (
        BrowserWindow as unknown as { getAllWindows?: () => BrowserWindow[] }
      ).getAllWindows;
      if (typeof allWindows !== "function") return false;
      const windows = allWindows.call(BrowserWindow);
      if (windows.length === 0) return false;
      return windows.every(
        (window) => window.isDestroyed()
          || window.webContents.isDestroyed()
          || !window.isVisible()
          || window.isMinimized(),
      );
    } catch {
      return false;
    }
  };

  const openCompanionStreams = async (ctx: CompanionStreamContext): Promise<void> => {
    const { generation, workspaceEpoch, accountEpoch } = ctx;
    const stale = (): boolean =>
      generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch;
    companionStreamContext = ctx;
    companionStreamsPaused = false;
    stopCompanionAccountEvents = await gateway.watchCompanionAccountEvents(
      accountEpoch,
      (event) => {
        if (stale()) return;
        stopCompanionChatStreams();
        stopCompanionLifecycle();
        emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, workspaceEpoch);
        void event;
      },
    );
    if (stale()) {
      stopCompanionAccountEvents?.();
      stopCompanionAccountEvents = null;
      return;
    }
    stopCompanionInboxEvents = await gateway.watchCompanionInboxEvents(
      companionInboxCursor,
      (delivery) => {
        if (stale()) return;
        companionInboxCursor = Math.max(companionInboxCursor, delivery.inboxSequence);
        companionInboxBroadcastSeq = Math.max(companionInboxBroadcastSeq, delivery.inboxSequence);
        if (companionInboxBroadcastTimer) return;
        companionInboxBroadcastTimer = setTimeout(() => {
          companionInboxBroadcastTimer = null;
          const inboxSequence = companionInboxBroadcastSeq;
          companionInboxBroadcastSeq = 0;
          if (stale()) return;
          emit("runtime", { kind: "companion_activity_changed", inboxSequence }, workspaceEpoch);
        }, 400);
      },
    );
  };

  /** 只收流：游标、generation、fence 定时器都要跨过一次"隐藏"活着。 */
  const closeCompanionStreams = (): void => {
    if (companionStreamsPaused) return;
    companionStreamsPaused = true;
    stopCompanionAccountEvents?.();
    stopCompanionAccountEvents = null;
    stopCompanionInboxEvents?.();
    stopCompanionInboxEvents = null;
  };

  /**
   * 窗口事件与 fence 心跳共用这一道判定。心跳那份是**兜底**：窗口的 show/hide 可能
   * 因为绑定时机（窗口在本模块注册之后才创建）而漏掉，漏掉的代价不该是"这一趟再也
   * 收不到伴星更新"，最坏只到 60 秒。
   */
  const reconcileCompanionStreamsForVisibility = (): void => {
    if (!companionStreamContext) return;
    if (!companionStreamsPaused) {
      if (allCompanionWindowsHidden()) closeCompanionStreams();
      return;
    }
    if (allCompanionWindowsHidden()) return;
    const ctx = companionStreamContext;
    // 补账：inbox 靠保留游标重连续读，但 account 流在隐藏期间丢的那一段（例如 epoch
    // 变了）没有任何流会补回来，只能显式让渲染层重取一次快照。
    emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, ctx.workspaceEpoch);
    void openCompanionStreams(ctx).catch(() => undefined);
  };

  const startCompanionLifecycle = async (workspaceEpoch: number): Promise<void> => {
    if (workspaceEpoch <= 0) {
      stopCompanionLifecycle();
      return;
    }
    if (companionLifecycleWorkspaceEpoch === workspaceEpoch
      && (stopCompanionAccountEvents || companionLifecycleDisabledEpoch === workspaceEpoch)) return;
    stopCompanionLifecycle();
    const generation = companionLifecycleGeneration;
    companionLifecycleWorkspaceEpoch = workspaceEpoch;
    try {
      const overview = await ns_companion.getCompanionAccountOverview(gateway.gatewayTransport);
      if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
      if (!overview.account.globalEnabled) {
        companionLifecycleDisabledEpoch = workspaceEpoch;
        emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, workspaceEpoch);
        return;
      }
      const renewFence = async () => {
        await gateway.renewCompanionRuntimeFence(overview.account.epoch, 120);
      };
      await renewFence();
      if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
      companionRuntimeFenceTimer = setInterval(() => {
        if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
        reconcileCompanionStreamsForVisibility();
        void renewFence().catch(() => undefined);
      }, 60_000);
      await openCompanionStreams({
        generation,
        workspaceEpoch,
        accountEpoch: overview.account.epoch,
      });
    } catch {
      if (generation === companionLifecycleGeneration) stopCompanionLifecycle();
      // Companion capability failure must not turn a valid auth session into a
      // false login failure. Individual surfaces expose the concrete reason.
    }
  };

  /** 退订/关窗后回收：没有订阅者的那条笔记连接不作数留着。 */
  const reconcileNoteDocStreams = (): void => {
    for (const noteId of [...noteDocStreams.keys()]) {
      if (!hasNoteDocSubscription(noteId)) stopNoteDocStream(noteId);
    }
  };

  const releaseSubscriptionsForWindow = (window: BrowserWindow): void => {
    // Window destruction is a hard sensitivity boundary. Do not let a
    // main-owned formal-assessment state survive the renderer that held the
    // task DOM, input, or Companion context.
    formalAssessmentGuard.failClosed("disconnected");
    clearSubscriptionsForWindow(window);
    if (!hasLearningRunSubscription()) stopLearningRunStreams();
    if (!hasCardGenerationSubscription()) stopCardGenerationStreams();
    if (!hasCompanionChatSubscription()) stopCompanionChatStreams();
    reconcileNoteDocStreams();
    stopCompanionLifecycle();
  };

  const bindWindowLifecycle = (window: BrowserWindow): void => {
    if (windowLifecycleBound.has(window)) return;
    windowLifecycleBound.add(window);
    window.once("closed", () => releaseSubscriptionsForWindow(window));
    window.webContents.once("destroyed", () => releaseSubscriptionsForWindow(window));
    // 重新加载（开发时的热重载、手动刷新）**不会**销毁 webContents，所以订阅表里那一
    // 份旧订阅会一直留在账上：没人来退订，它支撑着的那条流也就没人关。开发循环里每按
    // 一次刷新就多占一条，而服务端的每用户 SSE 上限只有 5——占满之后生成页再也收不到
    // 事件（就是"页面不动、只有手动刷新状态才动"那一条）。主框架导航只有重载这一种，
    // 所以在这一刻把这个窗口的订阅整份清掉：新文档会重新订，退订 IPC 找不到记录也只
    // 是 not_found，渲染层本来就吞掉它。
    window.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      clearSubscriptionsForWindow(window);
      if (!hasLearningRunSubscription()) stopLearningRunStreams(); else ensureTrackedLearningRunStreams();
      if (!hasCardGenerationSubscription()) stopCardGenerationStreams(); else ensureTrackedCardGenerationStreams();
    });
    // M16：窗口进出前台立刻收/放伴星那两条常连接。fence 心跳里还有同一道兜底，
    // 所以漏一次事件（例如窗口在本模块注册之后才创建）最坏只到 60 秒。
    const onVisibilityChange = (): void => reconcileCompanionStreamsForVisibility();
    window.on("show", onVisibilityChange);
    window.on("restore", onVisibilityChange);
    window.on("hide", onVisibilityChange);
    window.on("minimize", onVisibilityChange);
  };

  const refreshLearningRunSubscription = async (runId: string): Promise<void> => {
    try {
      const snapshot = await ns_learning.getLearningRun(gateway.gatewayTransport, runId);
      syncFormalGuard(snapshot);
      emit("learningRun", { kind: "learning_run_changed", runId: snapshot.runId, revision: snapshot.runRevision }, activeWorkspaceEpoch);
    } catch {
      formalAssessmentGuard.failClosed("disconnected");
      // A later GET through the normal renderer path remains the source of
      // truth. Stream failures never forward raw SSE data or private errors.
    }
  };

  const refreshCardGenerationSubscription = async (runId: string, eventCursor: number): Promise<void> => {
    try {
      const snapshot = await ns_note.getCardGenerationRun(gateway.gatewayTransport, runId);
      emit("cardGeneration", {
        kind: "card_generation_changed",
        runId: snapshot.runId,
        eventCursor,
        revision: snapshot.reviewDraftRevision,
      }, activeWorkspaceEpoch);
    } catch {
      // The renderer must re-query the strict run snapshot itself after a
      // stream gap. Raw SSE payloads and provider/candidate details stay main-only.
    }
  };

  /**
   * 两族流的端口：账本只问这四件事，闭包里的东西全靠它们进来。
   *
   * `subscribed()` 是**唯一**的"谁在看"来源，而订阅表的每一次增删都调一次
   * `reconcile` —— 账本因此不可能与订阅表分叉。这正是原来漏掉的那一条：连接只会
   * 越攒越多，直到服务端的每用户 SSE 上限把它们全数顶回（详见
   * `desktop-ipc-run-streams.ts` 开头那段实测）。
   */
  const learningRunStreamPorts: RunStreamPorts = {
    watch: (runId, onSequence) => gateway.watchLearningRunEvents(runId, onSequence),
    refresh: async (runId) => { await refreshLearningRunSubscription(runId); },
    subscribed: () => subscribedRunIds("learningRun"),
    workspaceEpoch: () => activeWorkspaceEpoch,
    onLost: () => formalAssessmentGuard.failClosed("disconnected"),
  };

  const cardGenerationStreamPorts: RunStreamPorts = {
    watch: (runId, onSequence) => gateway.watchCardGenerationEvents(runId, onSequence),
    refresh: refreshCardGenerationSubscription,
    subscribed: () => subscribedRunIds("cardGeneration"),
    workspaceEpoch: () => activeWorkspaceEpoch,
    // 建不上就留给渲染层自己的重读路径；这里不伪造事件。
  };

  const ensureTrackedLearningRunStreams = (): void => reconcileRunStreams(learningRunStreams, learningRunStreamPorts);

  /** 与 `trackCardGenerationRun` 同一条纪律：写侧只登记，开流交给订阅侧。 */
  const trackLearningRun = (runId: string): void => {
    learningRunStreams.tracked.add(runId);
  };

  /**
   * 记下"有这么一条 run"，**不在这里开流**。
   *
   * 写侧（开始生成／审核／翻面／保存／停止／重试／收尾）知道 runId，可它不知道有谁
   * 在看。以前这一发顺手就开流，于是每一次写都可能在没人订阅的情况下占一条长连接。
   * 现在写侧只登记，开流交给订阅侧，两边对上了才连。
   */
  const trackCardGenerationRun = (runId: string): void => {
    cardGenerationStreams.tracked.add(runId);
  };

  const ensureTrackedCardGenerationStreams = (): void => reconcileRunStreams(cardGenerationStreams, cardGenerationStreamPorts);

  /**
   * 伴星会话 SSE（§5.3）：每个会话维持一条流，事件逐帧转发给订阅方。
   *
   * `eventCursor` 来自回合响应（turn.accepted 的 seq），只收本轮之后的事件；
   * 同一会话已有流时不重复建连——先建的那条游标最旧，续传最完整。流的停止由
   * 订阅生命周期负责（最后一个订阅消失、窗口销毁、登出、切工作区）。
   */
  const ensureCompanionChatStream = (conversationId: string, eventCursor: number): void => {
    if (!hasCompanionChatSubscription(conversationId) || companionChatStreams.has(conversationId)) return;
    const streamWorkspaceEpoch = activeWorkspaceEpoch;
    void gateway.watchCompanionConversationEvents(
      conversationId,
      eventCursor,
      (event) => {
        if (streamWorkspaceEpoch !== activeWorkspaceEpoch) return;
        emit("companionChat", { kind: "companion_chat_event", conversationId, event }, activeWorkspaceEpoch);
      },
    ).then((stop) => {
      if (!hasCompanionChatSubscription(conversationId) || streamWorkspaceEpoch !== activeWorkspaceEpoch) {
        stop();
        return;
      }
      companionChatStreams.set(conversationId, stop);
    }).catch(() => undefined);
  };

  /**
   * 笔记协同的建连与门控（决定 7b）。
   *
   * 只在「协作空间 + 本人可写」时建那条 WS。两类不建连的场景不是"没有写入路径"，
   * 只是"没有实时传输"：
   *  - personal 空间：改一处走 `noteDocUpload` 一次性上送，离线时排队、重连后按序重发
   *    （服务端为此专门有幂等用例，重发不会算成第二次写入）；
   *  - collaborative 的只读成员：本来就不能写，正文走既有读路径。
   * 判据的**唯一**来源仍是服务端；这里只是决定要不要占一条长连接。
   */
  /**
   * 门控（决定 7b 的那一半按实测改了）：`personal` 不建连——那里物理上没有第二个人，
   * 占一条长连接只是白耗电。但**只读成员要建**：他读得到这篇（HTTP 就能读），实时看到
   * 别人的改动才是共享空间对他唯一的意义，而"谁还开着这一篇"那一排头像也要求他在场。
   * 服务端本来就会用 `Authenticated("readonly")` 告诉他（也告诉这台机器）他能不能写；
   * 主进程先前自己按角色挡在门外，等于把这道答复换成了自己的第二套判据。
   */
  const noteDocStreamAllowed = (): boolean => activeWorkspaceKind === "collaborative";

  const hasNoteDocSubscription = (noteId: string): boolean => {
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind === "noteDoc" && subscription.topic.noteId === noteId) return true;
    }
    return false;
  };

  const stopNoteDocStream = (noteId: string): void => {
    const entry = noteDocStreams.get(noteId);
    if (!entry) return;
    noteDocStreams.delete(noteId);
    // 欠的那份在场状态跟着连接一起作废：留给下一条连接补交，就是把上一个视图的
    // "我还开着"报到下一次真正打开这篇的时候。
    noteDocPresenceToReplay.delete(noteId);
    entry.handle.stop();
  };

  const stopNoteDocStreams = (): void => {
    for (const noteId of [...noteDocStreams.keys()]) stopNoteDocStream(noteId);
    // 本机那份文档与"还没送出去的增量"一起作废：留着的话，下一次写会把上一个空间的
    // 正文差分按到这篇头上——那是跨空间的内容缝合，比丢一次编辑严重得多。
    ns_note.dropNoteDocLocalSessions(gateway.gatewayTransport);
  };

  const ensureNoteDocStream = (noteId: string): void => {
    if (!noteDocStreamAllowed() || !hasNoteDocSubscription(noteId) || noteDocStreams.has(noteId)) return;
    const streamWorkspaceEpoch = activeWorkspaceEpoch;
    // 服务端的第一批帧可能在句柄入表之前就到了（建连是异步的，回调却是立刻挂上的），
    // 所以先落在闭包里，入表时一并带进去——漏掉这句答复的话，可写的那位也会被当成只读。
    let authorizedScope: "read-write" | "readonly" | null = null;
    // 连上了还压着一批离线增量，界面上就是"已经同步"的假象：先把欠的交清再建连接。
    // 交不掉（还是没网）不挡建连——那条链自己也会失败，而队列仍然原样留着。
    void ns_note.flushNoteDocPending(gateway.gatewayTransport, noteId).catch(() => undefined)
      // 交完就把本机那份重写一遍：不然"已经交出去了"这件事只活在内存里，重启后又
      // 会把同一批当成还没交，白重发一遍（服务端会当空操作，但界面上的等待是真的）。
      .then(() => persistNoteDocLocal(noteId))
      .then(() => ns_note.watchNoteDocument(gateway.gatewayTransport, gateway.noteDocTransportHandle, noteId, ({ noteId: _framedByGateway, ...event }) => {
      if (streamWorkspaceEpoch !== activeWorkspaceEpoch) return;
      if (event.type === "status") {
        // 可写的那句答复只在鉴权那一刻来一次，而**连接会掉**。掉了还留着
        // `read-write`，写入就继续并进那条已经发不出去的文档：provider 的 `send` 在
        // socket 不是 open 时**静默丢弃**（`readyState === Open` 才发），界面上照样是
        // "● 已写入，正在同步"，而这一篇的正文只活在主进程那份内存文档里——离开这篇
        // （transport 被销毁）就没了。所以连接不在时把这一位清掉，写入退回 HTTP 那条
        // 同一个增量口（服务端一样收到，且 `via` 如实报 `uploaded`）。
        const scope = event.status === "authenticated"
          ? (event.authorizedScope ?? authorizedScope)
          : null;
        authorizedScope = scope;
        const entry = noteDocStreams.get(noteId);
        if (entry) entry.authorizedScope = scope;
      }
      emit("noteDoc", { kind: "note_doc_event", noteId, event }, activeWorkspaceEpoch);
    })).then((handle) => {
      // 服务端说这篇不该有实时连接（仅自己可见）时拿到的是 null：不建连，
      // 但写入照常——`syncNoteDocUpdate` 没连接就走 HTTP 那同一个增量口。
      if (!handle) return;
      // 建连期间可能已经退订、切了空间或改了角色——那条连接不属于这里了。
      if (!hasNoteDocSubscription(noteId) || !noteDocStreamAllowed() || streamWorkspaceEpoch !== activeWorkspaceEpoch) {
        handle.stop();
        return;
      }
      noteDocStreams.set(noteId, { handle, workspaceEpoch: streamWorkspaceEpoch, authorizedScope });
      // 订阅回执比连接早，界面上那声报名字大概率已经落过一次空。连接就位就把记下的
      // 那份补交出去，否则对端永远少一枚印章，而这在这台机器上看不出来。
      const presence = noteDocPresenceToReplay.get(noteId);
      if (presence !== undefined) handle.setPresence(presence);
    }).catch(() => undefined);
  };

  const subscriptionMatchesPayload = (topic: SubscriptionTopicM2, topicKind: SubscriptionTopicM2["kind"], payload: M2SubscriptionEvent): boolean => {
    if (topic.kind !== topicKind) return false;
    if (topic.kind === "learningRun") return payload.kind === "learning_run_changed" && topic.runId === payload.runId;
    if (topic.kind === "cardGeneration") return payload.kind === "card_generation_changed" && topic.runId === payload.runId;
    if (topic.kind === "companionChat") return payload.kind === "companion_chat_event" && topic.conversationId === payload.conversationId;
    if (topic.kind === "noteDoc") return payload.kind === "note_doc_event" && topic.noteId === payload.noteId;
    return true;
  };

  const emit = (topic: SubscriptionTopicM2["kind"], payload: M2SubscriptionEvent, workspaceEpoch: number): void => {
    for (const [subscriptionId, subscription] of subscriptions) {
      if (!subscriptionMatchesPayload(subscription.topic, topic, payload) || subscription.window.isDestroyed() || subscription.window.webContents.isDestroyed()) continue;
      const event: GatewayEventV1 = gatewayEventSchema.parse({
        version: 1,
        subscriptionId,
        workspaceEpoch,
        cursor: generatedOpaqueId("cursor"),
        eventRevision: eventRevision++,
        kind: payload.kind,
        schemaRevision: DESKTOP_IPC_SCHEMA_REVISION,
        data: payload,
      });
      subscription.window.webContents.send(DESKTOP_IPC_CHANNELS.subscriptionsEvent, event);
    }
  };

  const rememberSession = (session: SessionContextV1): void => {
    if (session.status !== "authenticated" || !session.user || !session.workspace) {
      formalAssessmentGuard.failClosed("disconnected");
      activeSubjectId = null;
      activeWorkspaceId = null;
      activeWorkspaceKind = null;
      activeWorkspaceRole = null;
      // 判据一消失，所有协同连接都要退掉：留着一条属于上一个空间的连接，
      // 就是"切了空间还在收别人的正文"。
      stopNoteDocStreams();
      return;
    }
    activeSubjectId = session.user.userId;
    activeWorkspaceId = session.workspace.workspaceId;
    const kindChanged = activeWorkspaceKind !== session.workspace.workspaceType
      || activeWorkspaceRole !== session.workspace.role;
    activeWorkspaceKind = session.workspace.workspaceType;
    activeWorkspaceRole = session.workspace.role;
    // 换空间要退掉所有连接：留着一条属于上一个空间的连接，就是"切了空间还在收别人的正文"。
    // 角色变了也退：写入出口的判据现在取自服务端那条 `Authenticated(...)`，而它只在鉴权时
    // 给一次——不重连的话，被提升成 owner 的那个人手上还是"只读"，反过来则是拿一个已经不
    // 成立的写权限继续提交。界面上还有打开着的笔记时会重新订阅，届时按服务端的新答复走。
    if (kindChanged) stopNoteDocStreams();
  };

  const syncFormalGuard = (snapshot: unknown): void => {
    formalAssessmentGuard.syncFromSnapshot(snapshot, gateway.getConnectionState().kind === "ready");
  };

  const syncFormalGuardFromResult = (value: unknown): void => {
    if (typeof value === "object" && value !== null && "snapshot" in value) {
      syncFormalGuard(value.snapshot);
      return;
    }
    formalAssessmentGuard.failClosed("unknown");
  };

  const requireActionCapability = async (
    // 从共享常量派生而不是就地再列一遍：此前这里手写了 6 个字面量，新增能力时
    // 必须在两处同步（漏改一处就是"共享层有、客户端永远拒绝"的静默 403）。
    capability: Extract<ActionCapability, `card_generation.${string}`>,
    requestId?: string,
  ): Promise<void> => {
    const projection = await ns_source.getCapabilities(gateway.gatewayTransport, requestId);
    if (projection.actionCapabilities[capability] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
  };

  const resolveReturnContract = async (contractValue: unknown): Promise<void> => {
    const resolution = resolveLearningRunReturn(contractValue, { enabledRoutes: contract.enabledRoutes });
    if (!activeSubjectId || !activeWorkspaceId) return;
    if (resolution.kind === "pending") {
      await pendingReturnMarkerStore.set(activeSubjectId, activeWorkspaceId, resolution.marker);
    } else {
      await pendingReturnMarkerStore.clear(activeSubjectId, activeWorkspaceId);
    }
  };

  const completeFormalReleaseAfterRendererCleanup = (runId?: string): void => {
    const state = formalAssessmentGuard.getSnapshot();
    if (state.state !== "releasing" || !state.runId || state.runtimeEpoch === null) return;
    if (runId && state.runId !== runId) return;
    // A plain room.home navigation is also exposed to the shell. It is not
    // itself proof that the LearningRun Player has unmounted, so only allow
    // this fallback form after the main-owned run subscription has gone away.
    if (!runId && hasLearningRunSubscription()) return;
    formalAssessmentGuard.completeRelease({ runId: state.runId, runtimeEpoch: state.runtimeEpoch }, true);
  };

  const resolveLearningRunNavigation = async (
    runId: string,
    requestedRoute: DesktopRouteV1,
    requestId?: string,
  ): Promise<void> => {
    const contractValue = await ns_learning.getLearningRunReturnContract(gateway.gatewayTransport, runId, requestId);
    await resolveReturnContract(contractValue);
    const resolvedRoute = routeForLearningRunReturn(contractValue);
    if (!resolvedRoute || !matchesLearningRunReturnRoute(resolvedRoute, requestedRoute)) {
      throw new DesktopGatewayFailure("invalid_navigation", "user_action");
    }
    // The API's V2 return contract already authorizes and resolves the
    // schedule/objective target in the current subject/workspace scope. A
    // review item may legitimately stop being due immediately after a result
    // commits, so re-reading the due-only queue here would incorrectly turn a
    // safe review return into a room fallback.
  };

  const recoverPersistedReturnMarker = async (requestId?: string): Promise<void> => {
    if (!activeSubjectId || !activeWorkspaceId) return;
    await recoverPendingReturnMarker({
      markerStore: pendingReturnMarkerStore,
      subjectId: activeSubjectId,
      workspaceId: activeWorkspaceId,
      enabledRoutes: contract.enabledRoutes,
      query: (runId) => ns_learning.getLearningRunReturnContract(gateway.gatewayTransport, runId, requestId),
      clearOnError: (error) => error instanceof DesktopGatewayFailure
        && ["not_found", "forbidden", "unsupported_contract"].includes(error.code),
    });
  };

  const navigationEntryForContract = (
    route: DesktopRouteV1,
    meta: RequestMetaV1,
    entryKind: NavigationEntryV1["entryKind"],
  ): NavigationEntryV1 => {
    if (isM1Route(route)) return navigationEntry(route, meta, entryKind);
    if (!contract.enabledRoutes.includes(route.kind as (typeof desktopRouteKindM2Values)[number])) {
      throw new DesktopGatewayFailure("route_not_available", "user_action");
    }
    if (!activeWorkspaceId || activeWorkspaceEpoch < 1) {
      throw new DesktopGatewayFailure("auth_required", "user_action");
    }
    const level = route.kind === "room.home" ? "L0" : route.kind === "review.queue" ? "L1" : "L2";
    return {
      version: 1,
      scope: "workspace",
      historyKey: `workspace-${route.kind}`,
      workspaceId: activeWorkspaceId,
      workspaceEpoch: activeWorkspaceEpoch,
      route,
      level,
      entryKind,
      navigationOrigin: entryKind,
      focusReturnKey: route.kind,
      correlationId: meta.correlationId,
    };
  };

  ipcMain.on(DESKTOP_IPC_CHANNELS.contractGetSnapshot, (event) => {
    const window = options.resolveWindow(event.sender, event.senderFrame?.url ?? "");
    event.returnValue = window ? contract : null;
  });

  // 2026-09-30（第②步）：伴星这一族（56 条通道 / 385 行 + 49 个 schema）搬去
  // `desktop-ipc-companion.ts`。**deps 只有 16 项**——第①步把 148 份重复样板
  // 收进闭包版 `channel()` 之后，搬运才是纯搬运。
  registerCompanionChannels({
    // deps 里这几个定成宽松签名（写死了必对不上：`channel` 是泛型、
    // 路由门是 `(contract, route)`、`emit` 是 `(topic, payload)`）。
    // **运行时传的就是本文件里的同一个函数**，所以这里显式断言——比在 deps 里猜一遍签名可靠。
    channel: channel as never,
    installHandler: installHandler as never,
    requireM2Route: requireM2Route as never,
    requireAnyM2Route: requireAnyM2Route as never,
    assertEpoch: assertEpoch as never,
    emit: emit as never,
    contract,
    getActiveWorkspaceEpoch: () => activeWorkspaceEpoch,
    ns_companion,
    ns_source,
    gateway: gateway as never,
    options,
    getCompanionLifecycleDisabledEpoch: () => companionLifecycleDisabledEpoch,
    setCompanionLifecycleDisabledEpoch: (value: number) => { companionLifecycleDisabledEpoch = value; },
    startCompanionLifecycle,
    stopCompanionLifecycle,
  });

  // 2026-09-30（第②步）：「空间」这一族搬去 `desktop-ipc-workspace.ts`。
  // 纪元按 **getter** 传；宽松签名的那几个**真类型在本文件里断言**——传的就是同一个函数。
  registerWorkspaceChannels({
    channel: channel as never,
    installHandler: installHandler as never,
    requireM2Route: requireM2Route as never,
    requireAnyM2Route: requireAnyM2Route as never,
    assertEpoch: assertEpoch as never,
    emit: emit as never,
    contract,
    getActiveWorkspaceEpoch: () => activeWorkspaceEpoch,
    ns_workspace,
    gateway: gateway as never,
    options,
    // ③ 类：闭包里的 `let` 传 **getter**，容器与函数**传原引用**。
    getActiveSubjectId: () => activeSubjectId,
    setActiveSubjectId: (value: string | null) => { activeSubjectId = value; },
    getActiveWorkspaceId: () => activeWorkspaceId,
    setActiveWorkspaceId: (value: string | null) => { activeWorkspaceId = value; },
    setActiveWorkspaceEpoch: (value: number) => { activeWorkspaceEpoch = value; },
    assertEpochBoundaryExempt, safeWorkspaceEpoch, formalAssessmentGuard,
    pendingReturnMarkerStore, noteDocCache,
    recoverPersistedReturnMarker, rememberSession,
    startCompanionLifecycle, stopCompanionLifecycle, stopCompanionChatStreams,
    stopLearningRunStreams, stopCardGenerationStreams,
    trackedLearningRunIds: learningRunStreams.tracked, trackedCardGenerationRunIds: cardGenerationStreams.tracked,
  });


  // 2026-09-30（第②步）：「空间」这一族搬去 `desktop-ipc-auth.ts`。
  // 纪元按 **getter** 传；宽松签名的那几个**真类型在本文件里断言**——传的就是同一个函数。
  registerAuthChannels({
    channel: channel as never,
    installHandler: installHandler as never,
    requireM2Route: requireM2Route as never,
    requireAnyM2Route: requireAnyM2Route as never,
    assertEpoch: assertEpoch as never,
    emit: emit as never,
    contract,
    getActiveWorkspaceEpoch: () => activeWorkspaceEpoch,
    ns_auth,
    gateway: gateway as never,
    options,
    getActiveSubjectId: () => activeSubjectId,
    setActiveSubjectId: (value: string | null) => { activeSubjectId = value; },
    getActiveWorkspaceId: () => activeWorkspaceId,
    setActiveWorkspaceId: (value: string | null) => { activeWorkspaceId = value; },
    setActiveWorkspaceEpoch: (value: number) => { activeWorkspaceEpoch = value; },
    assertEpochBoundaryExempt, safeWorkspaceEpoch, formalAssessmentGuard,
    pendingReturnMarkerStore, noteDocCache, recoverPersistedReturnMarker, rememberSession,
    startCompanionLifecycle, stopCompanionLifecycle, stopCompanionChatStreams,
    stopLearningRunStreams, stopCardGenerationStreams,
    trackedLearningRunIds: learningRunStreams.tracked, trackedCardGenerationRunIds: cardGenerationStreams.tracked,
    clearSubscriptionsForWindow,
  });


  // 2026-09-30（第②步）：「空间」这一族搬去 `desktop-ipc-learning.ts`。
  // 纪元按 **getter** 传；宽松签名的那几个**真类型在本文件里断言**——传的就是同一个函数。
  registerLearningChannels({
    channel: channel as never,
    installHandler: installHandler as never,
    requireM2Route: requireM2Route as never,
    requireAnyM2Route: requireAnyM2Route as never,
    assertEpoch: assertEpoch as never,
    emit: emit as never,
    contract,
    getActiveWorkspaceEpoch: () => activeWorkspaceEpoch,
    ns_learning,
    gateway: gateway as never,
    options,
    getActiveSubjectId: () => activeSubjectId,
    setActiveSubjectId: (value: string | null) => { activeSubjectId = value; },
    getActiveWorkspaceId: () => activeWorkspaceId,
    setActiveWorkspaceId: (value: string | null) => { activeWorkspaceId = value; },
    setActiveWorkspaceEpoch: (value: number) => { activeWorkspaceEpoch = value; },
    assertEpochBoundaryExempt, safeWorkspaceEpoch, formalAssessmentGuard,
    pendingReturnMarkerStore, noteDocCache, recoverPersistedReturnMarker, rememberSession,
    startCompanionLifecycle, stopCompanionLifecycle, stopCompanionChatStreams,
    stopLearningRunStreams, stopCardGenerationStreams,
    trackedLearningRunIds: learningRunStreams.tracked, trackedCardGenerationRunIds: cardGenerationStreams.tracked,
    clearSubscriptionsForWindow,
    trackLearningRun: trackLearningRun as never,
    maybeInjectPackagedLearningRunResponseLoss: maybeInjectPackagedLearningRunResponseLoss as never,
    resolveReturnContract: resolveReturnContract as never,
    syncFormalGuard: syncFormalGuard as never,
    syncFormalGuardFromResult: syncFormalGuardFromResult as never,
  });


  // 2026-09-30（第②步）：「空间」这一族搬去 `desktop-ipc-source.ts`。
  // 纪元按 **getter** 传；宽松签名的那几个**真类型在本文件里断言**——传的就是同一个函数。
  registerSourceChannels({
    channel: channel as never,
    installHandler: installHandler as never,
    requireM2Route: requireM2Route as never,
    requireAnyM2Route: requireAnyM2Route as never,
    assertEpoch: assertEpoch as never,
    emit: emit as never,
    contract,
    getActiveWorkspaceEpoch: () => activeWorkspaceEpoch,
    ns_source,
    gateway: gateway as never,
    options,
    artifactUserDataDir,
  });


  // 2026-09-30（第②步）：「空间」这一族搬去 `desktop-ipc-rest.ts`。
  // 纪元按 **getter** 传；宽松签名的那几个**真类型在本文件里断言**——传的就是同一个函数。
  registerRestChannels({
    channel: channel as never,
    installHandler: installHandler as never,
    requireM2Route: requireM2Route as never,
    requireAnyM2Route: requireAnyM2Route as never,
    assertEpoch: assertEpoch as never,
    emit: emit as never,
    contract,
    getActiveWorkspaceEpoch: () => activeWorkspaceEpoch,
    // 这一段是笔记/理解/搜索/邀请的尾巴，它们都走**笔记那组自由函数**。
    ns_rest: ns_note,
    gateway: gateway as never,
    options,
    getActiveWorkspaceId: () => activeWorkspaceId,
    setActiveWorkspaceId: (value: string | null) => { activeWorkspaceId = value; },
    setActiveWorkspaceEpoch: (value: number) => { activeWorkspaceEpoch = value; },
    noteDocCacheKey, persistNoteDocLocal, noteDocStreams, noteDocPresenceToReplay,
    noteDocCache,
    trackCardGenerationRun: trackCardGenerationRun as never,
    requireActionCapability: requireActionCapability as never,
  });


  installHandler(DESKTOP_IPC_CHANNELS.runtimeGetSnapshot, runtimeInputSchema, options, async (_event, window, input) => {
    const snapshot = gateway.getRuntimeSnapshot(
      asWindowState(options.getWindowState(window)),
      options.getReducedMotion?.() ?? false,
    );
    return runtimeSnapshotSchema.parse(snapshot);
  }, undefined, runtimeSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.runtimeRetryApiConnection, runtimeInputSchema, options, async (_event, _window, input) => {
    try {
      const state = await ns_runtime.retryConnection(gateway.gatewayTransport, input.meta.requestId);
      const parsed = apiConnectionStateSchema.parse(state);
      if (parsed.kind !== "ready") formalAssessmentGuard.failClosed("disconnected");
      emit("runtime", { kind: "connection_changed", state: parsed }, activeWorkspaceEpoch);
      return parsed;
    } catch (error) {
      formalAssessmentGuard.failClosed("disconnected");
      throw error;
    }
  }, undefined, apiConnectionStateSchema);

  installHandler(DESKTOP_IPC_CHANNELS.runtimeGetHealth, runtimeInputSchema, options, async (_event, _window, input) => {
    const health = await ns_runtime.getHealth(gateway.gatewayTransport, input.meta.requestId);
    const snapshot: ApiHealthSnapshotV1 = apiHealthSnapshotSchema.parse({
      version: 1,
      status: health.status,
      serviceId: DESKTOP_API_SERVICE_ID,
      domainSchemaRevision: health.domainSchemaRevision,
      ...(health.instanceId ? { instanceId: health.instanceId } : {}),
      checkedAt: health.checkedAt,
      latencyMs: health.latencyMs,
    });
    return snapshot;
  }, undefined, apiHealthSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.runtimeCancel, cancelInputSchema, options, async (_event, _window, input) => {
    if (!ns_runtime.cancel(gateway.gatewayTransport, input.requestId)) throw new DesktopGatewayFailure("not_found", "never");
    return { cancelled: true as const };
  }, undefined, cancelOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.navigationResolve, navigationResolveInputSchema, options, async (_event, window, input) => {
    if (input.learningRunId) await resolveLearningRunNavigation(input.learningRunId, input.route, input.meta.requestId);
    const state = navigationState(window, input.meta);
    const entry = navigationEntryForContract(input.route, input.meta, "user");
    if (input.learningRunId || input.route.kind === "room.home") completeFormalReleaseAfterRendererCleanup(input.learningRunId);
    return { version: 1, current: entry, stackRevision: state.revision, canBack: state.entries.length > 1 } satisfies NavigationSnapshotV1;
  }, undefined, navigationSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.navigationGo, navigationGoInputSchema, options, async (_event, window, input) => {
    if (input.learningRunId) await resolveLearningRunNavigation(input.learningRunId, input.route, input.meta.requestId);
    const state = navigationState(window, input.meta);
    state.entries.push(navigationEntryForContract(input.route, input.meta, input.entryKind));
    state.revision += 1;
    if (input.learningRunId || input.route.kind === "room.home") completeFormalReleaseAfterRendererCleanup(input.learningRunId);
    return navigationSnapshot(state);
  }, undefined, navigationSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.navigationBack, runtimeInputSchema, options, (_event, window, input) => {
    const state = navigationState(window, input.meta);
    if (state.entries.length > 1) {
      state.entries.pop();
      state.revision += 1;
    }
    return navigationSnapshot(state);
  }, undefined, navigationSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.navigationRestore, runtimeInputSchema, options, (_event, window, input) => {
    const state = navigationState(window, input.meta);
    return navigationSnapshot(state);
  }, undefined, navigationSnapshotSchema);

  ;

  // 个人工作区改名：改的是会话里的当前空间名，顺带丢掉会话缓存。
  ;

  // Owner 的邀请发出与成员管理。写入全部由服务端 requireOwner 收口，
  // 这里不再复制一份角色判断，Member 调用只会得到 forbidden。
  ;

;


  installHandler(DESKTOP_IPC_CHANNELS.roomGetProjection, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getRoomProjection(input.meta.requestId);
  }, (output) => safeWorkspaceEpoch(output), roomProjectionV1Schema);

  ;

;

  for (const [channelName, mutate] of [
    [DESKTOP_IPC_CHANNELS.companionMemoryConfirm, "confirmCompanionMemory"],
    [DESKTOP_IPC_CHANNELS.companionMemoryPin, "pinCompanionMemory"],
    [DESKTOP_IPC_CHANNELS.companionMemoryUnpin, "unpinCompanionMemory"],
    [DESKTOP_IPC_CHANNELS.companionMemoryArchive, "archiveCompanionMemory"],
    [DESKTOP_IPC_CHANNELS.companionMemoryRestore, "restoreCompanionMemory"],
  ] as const) {
    channel(channelName, companionMemoryIdInputSchema, async (_event, _window, input) => {
      requireM2Route(contract, "room.home");
      assertEpoch(input.meta, activeWorkspaceEpoch);
      return gateway[mutate](input.memoryId, input.meta.requestId);
    }, companionMemoryItemV1Schema);
  }

;

  ;

  installHandler(DESKTOP_IPC_CHANNELS.capabilitiesGet, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    return ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
  }, (output) => safeWorkspaceEpoch(output), capabilityProjectionSchema);

  installHandler(DESKTOP_IPC_CHANNELS.windowGetState, runtimeInputSchema, options, (_event, window) => {
    return asWindowState(options.getWindowState(window));
  }, undefined, windowStateSnapshotV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.windowSetTitlebarTheme, windowThemeInputSchema, options, (_event, window, input) => {
    if (!options.setTitlebarTheme(window, input.theme)) throw new DesktopGatewayFailure("feature_disabled", "never");
    return { applied: true as const };
  }, undefined, titlebarThemeOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.windowFocus, runtimeInputSchema, options, (_event, window) => {
    window.focus();
    return { focused: true as const };
  }, undefined, focusOutputSchema);

  /**
   * 本地语音识别模型的四条设备级通道。
   *
   * **不要求工作区纪元**：模型在这台机器上，不在某个空间里。用户在设置页第一次
   * 点「下载」时可能还没登录任何空间，用 `assertEpoch` 会把这一次正当操作判成
   * `stale_workspace`，界面上只剩一句看不懂的失败。
   *
   * `mountUrl` 交的是**页面所在那个 origin** 下的保留前缀（算法见
   * `voiceAsrModelMountUrl`）：打包后由 app scheme 路由提供，开发时由开发服务器提供，
   * 两种形态都同源。
   */
  const voiceAsrModelMountUrlFor = (window: BrowserWindow): string => {
    try {
      return voiceAsrModelMountUrl(window.webContents.getURL(), process.env.ELECTRON_RENDERER_URL);
    } catch {
      throw new DesktopGatewayFailure("configuration_error", "never");
    }
  };
  for (const [channelName, run] of [
    [DESKTOP_IPC_CHANNELS.companionVoiceAsrModelState, null],
    [DESKTOP_IPC_CHANNELS.companionVoiceAsrModelDownload, "startDownload"],
    [DESKTOP_IPC_CHANNELS.companionVoiceAsrModelCancel, "cancel"],
    [DESKTOP_IPC_CHANNELS.companionVoiceAsrModelRemove, "remove"],
  ] as const) {
    channel(channelName, runtimeInputSchema, async (_event, window, input) => {
      assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
      const store = options.voiceAsrModelStore;
      if (!store) throw new DesktopGatewayFailure("configuration_error", "never");
      // 下载是长任务：发起即返回，进度靠再去读状态拿。把 239 MB 的等待压在
      // 一次 invoke 里，用户切走设置页就会把它一起带走。
      if (run) await store[run]();
      return voiceAsrModelSnapshotV1Schema.parse({
        version: 1,
        mountUrl: voiceAsrModelMountUrlFor(window),
        ...(await store.state()),
      });
    }, voiceAsrModelSnapshotV1Schema);
  }

  installHandler(DESKTOP_IPC_CHANNELS.clipboardReadLinks, runtimeInputSchema, options, () => {
    // 外部复制的链接只在这里过一遍：剪贴板原文截断后提取候选地址，
    // 原文永不过桥，渲染层拿到的只有至多 3 个 http(s) 地址。
    const text = clipboard.readText().slice(0, 4000);
    return clipboardReadLinksResultSchema.parse({ urls: extractCandidateLinks(text) });
  }, undefined, clipboardReadLinksResultSchema);

  installHandler(DESKTOP_IPC_CHANNELS.clipboardWriteText, z.strictObject({
    meta: requestMetaSchema,
    request: clipboardWriteTextRequestV1Schema,
  }), options, (_event, _window, input) => {
    clipboard.writeText(input.request.text);
    return { written: true as const };
  }, undefined, clipboardWriteTextResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.shellOpenExternal, shellOpenExternalInputSchema, options, async (_event, _window, input) => {
    // 唯一的信任边界：这条地址来自模型给的回答，渲染层怎么画都不算，只有这里决定要不要
    // 交给系统去开。白名单与渲染层共用合同里那一份判定（`isWebLinkUrl`），所以"画成能点"
    // 与"真能开"不会是两种口径。窗口本身永远不导航出去（`will-navigate` 仍拦外链）。
    if (!isWebLinkUrl(input.request.url)) {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    await shell.openExternal(new URL(input.request.url).toString());
    return { opened: true as const };
  }, undefined, shellOpenExternalResultV1Schema);

  // 自动更新。更新源是 GitHub Releases，主进程直连，不过 apps/api；
  // 状态由 desktop-update 单方面推给渲染层，这里只收四个动作。
  installHandler(DESKTOP_IPC_CHANNELS.updateGetState, updateGetStateInputV1Schema, options, () => {
    return { state: getUpdateState() };
  }, undefined, updateGetStateResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.updateCheck, updateCheckInputV1Schema, options, async (_event, _window, input) => {
    // schema 的 `.default(false)` 在**输出**上补值，`z.input` 上仍是可选的，
    // 所以这里显式收口——渲染层不传就是"非主动触发"，走 6 小时缓存。
    return checkForUpdates({ userInitiated: input.userInitiated === true });
  }, undefined, updateStateV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.updateDownload, updateDownloadInputV1Schema, options, async () => {
    return downloadUpdate();
  }, undefined, updateStateV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.updateInstall, updateInstallInputV1Schema, options, async () => {
    return installUpdate();
  }, undefined, updateStateV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe, subscribeInputSchema, options, (_event, window, input) => {
    if (input.topic.kind !== "runtime" && activeWorkspaceEpoch < 1) {
      throw new DesktopGatewayFailure("auth_required", "user_action");
    }
    const subscriptionId = generatedOpaqueId("subscription");
    bindWindowLifecycle(window);
    subscriptions.set(subscriptionId, { window, topic: input.topic });
    // 订阅表就是"谁在看"的唯一事实：增删两端都只调 reconcile，由它对着表开流/收流。
    if (input.topic.kind === "learningRun") ensureTrackedLearningRunStreams();
    if (input.topic.kind === "cardGeneration") ensureTrackedCardGenerationStreams();
    if (input.topic.kind === "companionChat") {
      // eventCursor 缺省 0（无回合游标的降级路径）：主进程从头重放，渲染层
      // 按 runId/generation 过滤，不会把历史帧渲染成本轮回复。
      ensureCompanionChatStream(input.topic.conversationId, input.topic.eventCursor ?? 0);
    }
    if (input.topic.kind === "noteDoc") {
      ensureNoteDocStream(input.topic.noteId);
    }
    return { subscriptionId };
  }, undefined, subscriptionOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.subscriptionsUnsubscribe, unsubscribeInputSchema, options, (_event, window, input) => {
    const subscription = subscriptions.get(input.subscriptionId);
    if (!subscription || subscription.window !== window) throw new DesktopGatewayFailure("not_found", "never");
    subscriptions.delete(input.subscriptionId);
    // 退订也要对齐账本：**按 run 逐条**对，而不是"一个都不剩就全关"。
    // 只在归零时全关的话，"笔记页还订着 A、工作台退订了 B"这种切换会把 B 的流留着，
    // 而 B 已经没人看了——长连接就是这么一点点攒到服务端的每用户上限的。
    if (hasLearningRunSubscription()) ensureTrackedLearningRunStreams(); else stopLearningRunStreams();
    if (hasCardGenerationSubscription()) ensureTrackedCardGenerationStreams(); else stopCardGenerationStreams();
    // 一篇笔记可能被多个窗口同时订阅，所以不能"有一条退订就关连接"。
    reconcileNoteDocStreams();
    if (subscription.topic.kind === "companionChat" && !hasCompanionChatSubscription(subscription.topic.conversationId)) {
      stopCompanionChatStream(subscription.topic.conversationId);
    }
    return { closed: true as const };
  }, undefined, closedSubscriptionOutputSchema);

  ;

  // ─── 首页「只推一件」（39d W7-4 刀七；39 §12.1）────────────────────────
  //
  // 两条都挂 `note.library` 的 M2 路线门槛：首页那件读的是**目标与轮次**，与笔记屏
  // 同属"学习空间"这一族，而把它挂到一个更宽的门槛上就等于让它在未初始化时先露头。
  installHandler(DESKTOP_IPC_CHANNELS.homeSuggestionRead, z.strictObject({
    ...m1InputBase,
    timeZone: z.string().min(1),
  }), options, async (_event, _window, input) => {
    requireM2Route(contract, "note.library");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return ns_home.readHomeSuggestion(gateway.gatewayTransport, input.timeZone, input.meta.requestId);
  }, undefined, homeSuggestionWireV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.todayBatchOption, z.strictObject({
    ...m1InputBase,
    request: todayBatchOptionCommandV2Schema,
  }), options, async (_event, _window, input) => {
    requireM2Route(contract, "note.library");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.actOnTodayBatch(input.request, input.meta.requestId);
  }, undefined, todayBatchOptionResultV2Schema);

  /**
   * 今日复习那一批的读侧（39d W7-4 刀十四）。
   *
   * ⚠️ 2026-09-30 补上：`desktop-ipc-channel-coverage` 一直红在这条通道上——
   * 「契约里声明了、主进程却没注册 handler」。补上之后「今天这一批」才真的能读出来，
   * 之前真窗口里它永远落进 `TodayBatchSurface` 的失败分支（见 `desktop-gateway.ts`
   * 里那个 `readTodayBatch` 的注释）。
   *
   * `timeZone` 按 preload/共享接口放在 `meta` 旁边；它决定服务端算「今天」的时区。
   */
  installHandler(DESKTOP_IPC_CHANNELS.todayBatchRead, z.strictObject({
    ...m1InputBase,
    timeZone: z.string().min(1).max(80),
  }), options, async (_event, _window, input) => {
    requireM2Route(contract, "note.library");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.readTodayBatch(input.timeZone, input.meta.requestId);
  });

  installHandler(DESKTOP_IPC_CHANNELS.homeSuggestionAct, z.strictObject({
    ...m1InputBase,
    request: homeSuggestionActionCommandV2Schema,
  }), options, async (_event, _window, input) => {
    requireM2Route(contract, "note.library");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return ns_home.actOnHomeSuggestion(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, undefined, homeSuggestionActionResultV2Schema);

  // ─── 判定的争议（39 §14.2、§16.11、§16.25）────────────────────────────────
  //
  // 一整组此前在客户端**不存在**，而结果页已经印着"也可以现在结束争议、把这一项
  // 暂不安排"——那句话承诺了一个点不到的入口（§16.11／16.22／16.25 三条验收
  // 都要求用户能提出或查看异议，按现状它们都无法验收）。
  //
  // 面只认 `learningRun.detail`：争议是**一次判定的**个人数据，挂在别的面上等于
  // 让它在没有那条判定的上下文里也能被提交。三条写都走 `assertEpoch`（fail closed）：
  // 切空间之后带着旧 epoch 回来开一份争议，等于在**新**空间里对一条不存在的判定申诉。
  //
  // 刻意只有这四条：`recheck` 与 `correction` 的写入方是系统而不是人
  // （§14.2「系统基于原题、原回答和依据进行一次重新检查」），挂上来就是把一次复核
  // 变成一个能被重复按下的按钮，而 §16.22 的验收原话是"争议不形成死循环"。

  installHandler(DESKTOP_IPC_CHANNELS.assessmentDisputeGet, assessmentDisputeGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return ns_assessment.getAssessmentDispute(gateway.gatewayTransport, input.assessmentId, input.meta.requestId);
  }, undefined, assessmentDisputeEnvelopeV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.assessmentDisputeOpen, assessmentDisputeOpenInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return ns_assessment.openAssessmentDispute(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, undefined, openAssessmentDisputeResultV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.assessmentDisputeSupplement, assessmentDisputeSupplementInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return ns_assessment.supplementAssessmentDispute(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, undefined, assessmentDisputeSupplementResultV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.assessmentDisputeClose, assessmentDisputeCloseInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return ns_assessment.closeAssessmentDispute(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, undefined, closeAssessmentDisputeResultV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.activityGetToday, activityGetTodayInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getTodayActivity(input.from, input.to, input.meta.requestId);
  }, undefined, todayActivityV1Schema);

  // 「全部空间」统计与今日日志同页。它是**读**通道，所以走 assertEpoch（fail
  // closed）：切空间后带着旧 epoch 回来的读数必须被拒，不能把上一个空间的合计
  // 落到新空间的界面上。
  installHandler(DESKTOP_IPC_CHANNELS.statsGetOverviewAll, statsGetOverviewAllInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getAllWorkspacesStatsOverview(input.meta.requestId);
  }, undefined, allWorkspacesStatsOverviewSchema);

  ;

  return contract;
}
