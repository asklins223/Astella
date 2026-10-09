import {
  setPersonalRelationDecisionV2ResultSchema,
  setPersonalRelationDecisionV2Schema,
} from "@astella/shared/personal-relation-decision-rules-v2";
import * as ns_source from "./desktop-gateway-ns-source";
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
  avatarGetResultV1Schema,
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
  ns_auth: typeof import("./desktop-gateway-ns-auth");
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
const logoutOutputSchema = z.strictObject({ loggedOut: z.literal(true), serverRevoked: z.boolean() });
const changePasswordOutputSchema = z.strictObject({ changed: z.literal(true), sessionsRevoked: z.literal(true) });

export function registerAuthChannels(deps: AuthChannelDeps): void {
  const {
    channel, installHandler, requireM2Route, requireAnyM2Route, assertEpoch,
    contract, getActiveWorkspaceEpoch, ns_auth, gateway, options, emit,
    getActiveSubjectId, setActiveSubjectId, getActiveWorkspaceId, setActiveWorkspaceId,
    setActiveWorkspaceEpoch,
    assertEpochBoundaryExempt, safeWorkspaceEpoch, formalAssessmentGuard,
    pendingReturnMarkerStore, noteDocCache, recoverPersistedReturnMarker, rememberSession,
    startCompanionLifecycle, stopCompanionLifecycle, stopCompanionChatStreams,
    stopLearningRunStreams, stopCardGenerationStreams, trackedLearningRunIds,
    trackedCardGenerationRunIds, clearSubscriptionsForWindow,
  } = deps;

installHandler(DESKTOP_IPC_CHANNELS.authGetState, runtimeInputSchema, options, async (_event, _window, input) => {
    const session = await ns_auth.getSession(gateway.gatewayTransport, input.meta.requestId);
    setActiveWorkspaceEpoch(session.status === "authenticated" || session.status === "reauth_required" ? session.workspaceEpoch : 0);
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    if (session.status === "authenticated") void startCompanionLifecycle(session.workspaceEpoch);
    else stopCompanionLifecycle();
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authGetSurfaceManifest, runtimeInputSchema, options, async (_event, _window, input) => {
    return ns_auth.getAuthSurfaceManifest(gateway.gatewayTransport, input.meta.requestId);
  }, undefined, authSurfaceManifestResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.authLogin, authLoginInputSchema, options, async (_event, _window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    const session = await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, input.email, input.password, input.meta.requestId, input.remember);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    void startCompanionLifecycle(session.workspaceEpoch);
    emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, getActiveWorkspaceEpoch());
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authRegister, authRegisterInputSchema, options, async (_event, _window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    const session = await ns_auth.register(gateway.gatewayTransport, gateway.companionBridge, input.email, input.password, input.inviteToken, input.displayName, input.meta.requestId, input.remember);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authJoinWorkspace, authJoinWorkspaceInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    const session = await ns_auth.joinWorkspace(gateway.gatewayTransport, input.inviteToken, input.meta.requestId);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authLogout, runtimeInputSchema, options, async (_event, window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    try {
      const result = await ns_auth.logout(gateway.gatewayTransport, gateway.companionBridge, input.meta.requestId);
      stopLearningRunStreams();
      trackedLearningRunIds.clear();
      stopCardGenerationStreams();
      trackedCardGenerationRunIds.clear();
      stopCompanionChatStreams();
      stopCompanionLifecycle();
      setActiveWorkspaceEpoch(0);
      // 退登要连本机那份正文一起清掉：它存的是笔记内容，不是可以留给下一个登录者的
      // 元数据。缓存键里的 subjectId 挡住了别人读到，但账号换到人这一侧也要主动删。
      // 身份是两个 `let`：**读用 getter，写用 setter**。
      // 提到局部变量——getter 每次调用都重算，TS 不跨调用保持可空收窄。
      const leavingSubjectId = getActiveSubjectId();
      if (leavingSubjectId) {
        await pendingReturnMarkerStore.clearSubject(leavingSubjectId);
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
      stopLearningRunStreams();
      trackedLearningRunIds.clear();
      stopCardGenerationStreams();
      trackedCardGenerationRunIds.clear();
      stopCompanionChatStreams();
      stopCompanionLifecycle();
      const subjectId = getActiveSubjectId();
      if (subjectId) await pendingReturnMarkerStore.clearSubject(subjectId);
      // 退登要连本机那份正文一起清掉：它存的是笔记内容，不是可以留给下一个登录者的
      // 元数据。缓存键里的 subjectId 挡住了别人读到，但账号换到人这一侧也要主动删。
      const sid = getActiveSubjectId();
      if (sid) await noteDocCache.clearSubject(sid);
      clearSubscriptionsForWindow(window);
      throw error;
    }
  }, undefined, logoutOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authReauthenticate, authReauthenticateInputSchema, options, async (_event, _window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    const session = await ns_auth.reauthenticate(gateway.gatewayTransport, gateway.companionBridge, input.password, input.meta.requestId);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authChangePassword, authChangePasswordInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    formalAssessmentGuard.failClosed("disconnected");
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
