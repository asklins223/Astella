import { noteReflectionPageV1Schema, noteReflectionWriteResultV1Schema, type NoteReflectionCommandV1 } from "@astella/shared/note-learning-reflection-contracts";
import type { NoteDocLocalSession } from "./desktop-gateway-ns-note";
const noteDocLocalSessions = new Map<string, NoteDocLocalSession>();
import * as ns_note from "./desktop-gateway-ns-note";
import type { CompanionGuidanceAudioCache } from "./companion-guidance-audio-cache";
import { noteAnnotationPageV1Schema, noteAnnotationWriteResultV1Schema, createNoteAnnotationTaskV1Schema, noteAnnotationLatestTaskQueryV1Schema, noteAnnotationLatestTaskV1Schema, noteAnnotationTaskV1Schema, type NoteAnnotationCommandV1 } from "@astella/shared/note-annotation-contracts";
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
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  setPersonalRelationDecisionV2ResultSchema,
  type PersonalRelationDecisionV2,
  type PersonalRelationKindV2Wire,
  type SetPersonalRelationDecisionV2Result,
} from "@astella/shared/personal-relation-decision-rules-v2";
import { learningDashboardV2Schema, type LearningDashboardV2 } from "@astella/shared";
import { allWorkspacesStatsOverviewSchema, type AllWorkspacesStatsOverviewV1 } from "@astella/shared/stats-overview-contracts";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  desktopRouteKindM2Values,
  apiConnectionStateSchema,
  capabilityProjectionSchema,
  desktopTrustChallengeRequestSchema,
  desktopTrustChallengeResponseSchema,
  desktopTrustSignatureMessage,
  deploymentConfigSchema,
  emailSchema,
  uuidSchema,
  AVATAR_MAX_BYTES,
  authProfileResultV1Schema,
  authSurfaceManifestResultV1Schema,
  avatarObjectKeySchema,
  avatarUploadResultV1Schema,
  inviteCreatedV1Schema,
  inviteListResultV1Schema,
  memberListResultV1Schema,
  renameWorkspaceResultV1Schema,
  dissolvePreviewResultV1Schema,
  dissolveWorkspaceResultV1Schema,
  transferWorkspaceOwnershipResultV1Schema,
  type DissolvePreviewResultV1,
  type DissolveWorkspaceResultV1,
  type TransferWorkspaceOwnershipResultV1,
  createWorkspaceResultV1Schema,
  searchDriftResultV1Schema,
  searchReindexResultV1Schema,
  type AuthProfileResultV1,
  type AvatarUploadResultV1,
  type InviteCreatedV1,
  type InviteListResultV1,
  type MemberListResultV1,
  type RenameWorkspaceResultV1,
  type CreateWorkspaceResultV1,
  type SearchDriftResultV1,
  type SearchReindexResultV1,
  type DesktopCreateLearningRunV2Request,
  type DesktopCardGenerationActivationSelectionV1,
  type DesktopCandidateReviewRequestV2,
  type DesktopCreateCardGenerationRunRequestV2,
  type DesktopRevealCandidateRequestV2,
  type DesktopNoteSaveRequestV1,
  type DesktopLearningRunActionRequestV2,
  type DesktopLearningRunAbandonRequestV2,
  type DesktopPutLearningTaskDraftV2Request,
  type DesktopRecordLearningRunActivityLeaseRequestV2,
  type DesktopSubmitTaskArtifactV2,
  recordLearningRunActivityLeaseOutputV2Schema,
  localApiTrustSchema,
  nonEmptyStringSchema,
  runtimeSnapshotSchema,
  sessionContextSchema,
  companionChatStreamEventV1Schema,
  type ApiConnectionStateV1,
  type CapabilityProjectionV1,
  type CompanionChatStreamEventV1,
  type DeploymentConfigV1,
  type GatewayErrorCode,
  type LocalApiTrustV1,
  type AiDataPolicyV1,
  type NativeCapabilityProjectionV1,
  type RuntimeSnapshotV1,
  type SessionContextV1,
  type WorkspaceAiSettingsV1,
  type WorkspaceContextV1,
  type WorkspaceSummaryV1,
  windowStateSnapshotV1Schema,
  workspaceAiSettingsV1Schema,
  noteDocServerStateV1Schema,
  noteDocStateResultV1Schema,
  noteDocUploadResultV1Schema,
  type NoteDocStateResultV1,
  type NoteDocStreamEventV1,
  type NoteDocUploadResultV1,
} from "@astella/shared/desktop-ipc-contracts";
import {
  createNoteDocState,
  mergeNoteDocUpdates,
  type NoteDocState,
} from "./note-doc-state.ts";
import {
  NOTE_DOC_PREFIX,
  defaultNoteDocTransport,
  noteDocStreamUrl,
  toNoteDocStreamEvent,
  type NoteDocTransport,
  type NoteDocTransportHandle,
  type NoteDocWatchHandle,
} from "./note-doc-transport.ts";
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
  todayBatchWireV2Schema,
  objectiveHoldCommandV2Schema,
  objectiveHoldResultV2Schema,
  objectiveResumeCommandV2Schema,
  objectiveResumeResultV2Schema,
  reviewSubscriptionCommandV2Schema,
  reviewSubscriptionResultV2Schema,
} from "@astella/shared/review-queue-v2-contracts";
import {
  closeAssessmentDisputeCommandV2Schema,
  closeAssessmentDisputeResultV2Schema,
  openAssessmentDisputeCommandV2Schema,
  openAssessmentDisputeResultV2Schema,
  supplementAssessmentDisputeCommandV2Schema,
  assessmentDisputeEnvelopeV2Schema,
} from "@astella/shared/assessment-dispute-rules-v2";
import { todayActivityV1Schema } from "@astella/shared/activity-surface-contracts";
import { roomProjectionV1Schema, type RoomProjectionV1 } from "@astella/shared/room-projection-contracts";
import {
  companionAccountGlobalOffEventV1Schema,
  companionAccountStateV1Schema,
  companionAnswerModePreferenceV1Schema,
  companionVoicePreferenceV1Schema,
  companionOverviewSchema,
  onboardingTransitionResponseSchema,
  runtimeFenceResponseSchema,
  type CompanionAccountPatch,
  type CompanionAccountGlobalOffEventV1,
  type CompanionAccountStateV1,
  type CompanionOverview,
  type OnboardingTransitionRequest,
  type OnboardingTransitionResponse,
  type RuntimeFenceResponse,
} from "@astella/shared/companion-shell-contracts";
import { type TtsEngineV1 } from "@astella/shared/tts-voice-catalog";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfileV1Schema,
  type CompanionHomeProjectionV1,
  type CompanionRoomProfilePatchV1,
  type CompanionRoomProfileV1,
} from "@astella/shared/companion-home-contracts";
import {
  COMPANION_VOICE_MAX_AUDIO_BYTES,
  COMPANION_VOICE_SPEAK_VOICE,
  companionVoicePlaybackOutcomeResultV1Schema,
  companionVoiceSpeakResultV1Schema,
  type CompanionVoicePlaybackOutcomeRequestV1,
  type CompanionVoicePlaybackOutcomeResultV1,
  type CompanionVoiceSpeakRequestV1,
  type CompanionVoiceSpeakSegmentRequestV2,
  type CompanionVoiceSpeakResultV1,
} from "@astella/shared/companion-voice-contracts";
import {
  companionAgentRoutesListResultV1Schema,
  companionRunNodesListResultV1Schema,
  companionChatOpenThoughtResultV1Schema,
  companionChatEnsureResultV1Schema,
  companionChatListMessagesResultV1Schema,
  companionChatProposalDecideResultV1Schema,
  companionChatProposalGetResultV1Schema,
  companionChatSendTurnResultV1Schema,
  type CompanionAgentRoutesListRequestV1,
  type CompanionAgentRoutesListResultV1,
  type CompanionChatEnsureRequestV1,
  type CompanionChatEnsureResultV1,
  type CompanionChatListMessagesRequestV1,
  type CompanionChatListMessagesResultV1,
  type CompanionChatProposalDecideRequestV1,
  type CompanionChatProposalDecideResultV1,
  type CompanionChatProposalGetRequestV1,
  type CompanionChatProposalGetResultV1,
  type CompanionChatSendTurnRequestV1,
  type CompanionChatSendTurnResultV1,
  type CompanionChatOpenThoughtRequestV1,
  type CompanionChatOpenThoughtResultV1,
  type CompanionChatCancelRunRequestV1,
  type CompanionChatCancelRunResultV1,
  companionChatCancelRunResultV1Schema,
  type CompanionRunNodesListRequestV1,
  type CompanionRunNodesListResultV1,
} from "@astella/shared/companion-chat-desktop-contracts";
import {
  companionGroundedTutorGrantV1Schema,
  companionLearningContextV1Schema,
  companionLearningRunContextV1Schema,
  companionStreamEventV1Schema,
  type CompanionGroundedTutorGrantV1,
  type CompanionLearningContextV1,
  type CompanionLearningRunContextV1,
  type CreateCompanionLearningRunContextGrantRequestV1,
} from "@astella/shared/companion-conversation-contracts";
import {
  SOURCE_IMAGE_MAX_BYTES,
  SOURCE_IMAGE_MIME_TYPES,
  sourceImageGetResultV1Schema,
  type SourceImageGetRequestV1,
  type SourceImageGetResultV1,
} from "@astella/shared/source-image-contracts";
import {
  NOTE_IMAGE_UPLOAD_MAX_BYTES,
  noteImageUploadResultV1Schema,
  type NoteImageUploadRequestV1,
  type NoteImageUploadResultV1,
} from "@astella/shared/note-image-upload-contracts";
import {
  assistantDeliveryV2Schema,
  assistantContextRenewResultV2Schema,
  assistantContextSnapshotV2Schema,
  mainPageContextInputV2Schema,
  type AssistantContextSnapshotV2,
  type AssistantDeliveryV2,
  type MainPageContextInputV2,
} from "@astella/shared/companion-bridge-contracts";
import {
  companionDailySummaryV1Schema,
  companionDailyMonthV1Schema,
  companionActivityDeliveryV1Schema,
  companionActivityTimelineV1Schema,
  companionAuditDeleteResultV1Schema,
  companionHistoryClearResultV1Schema,
  companionHistoryPageV1Schema,
  companionHistorySearchV1Schema,
  companionMemoryItemV1Schema,
  companionMemoryClearResultV1Schema,
  companionMemoryConflictListV1Schema,
  companionMemoryConflictResolveResultV1Schema,
  companionMemoryListV1Schema,
  companionMemoryQueueResultV1Schema,
  companionMemoryStarMapV2Schema,
  companionPersonaMutationV1Schema,
  companionPersonaResetV1Schema,
  companionPersonaV1Schema,
  type CompanionDailySummaryV1,
  type CompanionDailyMonthV1,
  type CompanionActivityDeliveryV1,
  type CompanionActivityTimelineV1,
  type CompanionActivityAckRequestV1,
  type CompanionAuditDeleteResultV1,
  type CompanionHistoryClearResultV1,
  type CompanionHistoryPageV1,
  type CompanionHistoryQueryV1,
  type CompanionHistorySearchQueryV1,
  type CompanionHistorySearchV1,
  type CompanionMemoryItemV1,
  type CompanionMemoryCreateInputV1,
  type CompanionMemoryCorrectInputV1,
  type CompanionMemoryListQuery,
  type CompanionMemoryListV1,
  type CompanionMemoryStarMapV2,
  type CompanionPersonaMutationV1,
  type CompanionPersonaPatchV1,
  type CompanionPersonaResetV1,
  type CompanionPersonaV1,
} from "@astella/shared/companion-memory-desktop-contracts";
import { companionConversationV1Schema } from "@astella/shared/companion-conversation-contracts";
import {
  companionInvitationSchema,
  companionJourneyBootstrapSchema,
  companionJourneySchema,
  type CompanionInvitationActionRequest,
  type CompanionInvitationV2,
  type CompanionJourneyActionRequest,
  type CompanionJourneyBootstrap,
  type CompanionJourneyV2,
} from "@astella/shared/companion-journey-contracts";

import { noteDetailV1Schema, type NoteDetailV1 } from "@astella/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema, type NoteSaveReceiptV1 } from "@astella/shared/note-save-contracts";
import { noteShareScopeReceiptV1Schema, type NoteShareScopeV1, type NoteShareScopeReceiptV1 } from "@astella/shared/note-share-contracts";
import {
  desktopSourceListPageSchema,
  desktopSourceDetailSchema,
  desktopSourceCreateResultV1Schema,
  desktopSourceNotesPageSchema,
  desktopNoteListPageSchema,
  desktopNoteVersionListSchema,
  desktopSearchPageSchema,
  type DesktopSourceListPage,
  type DesktopSourceDetail,
  type DesktopSourceCreateResultV1,
  type DesktopSourceCreateRequest,
  type DesktopSourceNotesPage,
  type DesktopSourceNoteResult,
  type DesktopSourceUpdateRequest,
  type DesktopSourceArchiveResult,
  type DesktopSourceReparseResult,
  desktopSourceRestoreResultSchema,
  type DesktopSourceRestoreResult,
  type DesktopNoteListPage,
  type DesktopNoteCreateRequest,
  type DesktopNoteMutationResult,
  type DesktopNoteVersionList,
  type DesktopSearchPage,
  type DesktopAiAuditPageV1,
  desktopAiAuditPageV1Schema,
} from "@astella/shared/desktop-surface-contracts";
import { objectiveListPageV3Schema, learningObjectiveSurfaceV3Schema, type ObjectiveListPageV3, type LearningObjectiveSurfaceV3 } from "@astella/shared/learning-objective-surface-contracts";
import {
  noteLearningRoundHistoryPageV1Schema,
  noteLearningRoundPersonalHistoryPageV1Schema,
  noteLearningRoundViewV1Schema,
  type NoteLearningRoundViewV1,
  ROUND_HISTORY_DEFAULT_LIMIT_V1,
  roundTeachingViewV1Schema,
  type NoteLearningRoundHistoryV1,
  type NoteLearningRoundPersonalHistoryV1,
  type NoteLearningRoundV1Wire,
  type RoundTeachingViewV1,
} from "@astella/shared/note-learning-round-contracts";
import { noteRouteCoverageV1Schema, type NoteRouteCoverageV1 } from "@astella/shared/note-route-coverage-v2";
import {
  recordRecallSourceRevealResultV1Schema,
  type RecallWaitingKindV1,
  type RecordRecallSourceRevealResultV1,
} from "@astella/shared/recall-waiting-v2-contracts";
import { understandingTopologySnapshotV3Schema, type NoteDeepeningSnapshotV1 } from "@astella/shared/note-deepening-contracts";
import { noteDeepeningV3Schema, type NoteDeepeningV3 } from "@astella/shared/note-deepening-v3-contracts";
import {
  activateCardCandidatesRequestV2Schema,
  candidateActionCommandV2Schema,
  candidateRevealV2Schema,
  cardActivationReceiptV2Schema,
  cardPlanV2Schema,
} from "@astella/shared/card-generation-v2-contracts";
import {
  cardActivationReceiptDesktopV1Schema,
  cardGenerationActiveSummaryListV1Schema,
  cardGenerationCandidateListV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationExposureEligibilityV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRunServerViewV2Schema,
  cardGenerationRunSnapshotV1Schema,
  cardGenerationCancelResultV1Schema,
  cardGenerationRetryResultV1Schema,
  projectCardActivationReceiptV1,
  projectCardGenerationRunSnapshotV1,
  type CardGenerationRunServerViewV2,
  type CardGenerationRunSnapshotV1,
  type CardGenerationActiveSummaryV1,
  type CardGenerationActiveSummaryListV1,
  type CardGenerationCandidateListV1,
  type CardGenerationJobAcceptedV1,
  type CardGenerationReviewResultV1,
  type CardGenerationCloseResultV1,
  type CardGenerationCancelResultV1,
  type CardGenerationRetryResultV1,
  type CardGenerationExposureEligibilityV1,
  type CardActivationReceiptDesktopV1,
} from "@astella/shared/card-generation-desktop-contracts";
import { projectLearningDashboardToRoomProjection } from "./room-projection";
import { computeClientReviewHashV2 } from "@astella/shared/card-generation-v2-hashing";
import { ARTIFACT_MAX_BYTES } from "./artifact-surface";
// 2026-09-30 拆出：传输层与它依赖的两个类型各自成文件。`GatewayTransport` 持有
// 发请求所需的那一小块状态（`request` 的传递闭包，恰好 11 个成员）——
// 先抽状态、再搬方法，理由见那个文件的头。
import * as ns_source from "./desktop-gateway-ns-source";
import * as ns_auth from "./desktop-gateway-ns-auth";
import * as ns_runtime from "./desktop-gateway-ns-runtime";
import {
  GatewayTransport,
  rawAuthMeSchema,
  rawHealthSchema,
  rawWorkspaceListSchema,
  rawReadinessSchema,
  type GatewayConfiguration,
} from "./desktop-gateway-transport";
import * as ns_learning from "./desktop-gateway-ns-learning";
import * as ns_workspace from "./desktop-gateway-ns-workspace";
import { CompanionBridge, projectCompanionDelivery } from "./desktop-gateway-companion-bridge";
import * as ns_assessment from "./desktop-gateway-ns-assessment";
import * as ns_search from "./desktop-gateway-ns-search";
import * as ns_invite from "./desktop-gateway-ns-invite";
import * as ns_home from "./desktop-gateway-ns-home";
import * as ns_artifact from "./desktop-gateway-ns-artifact";
import { safeUuid } from "./desktop-gateway-uuid";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import type { SessionCredentialStore } from "./desktop-gateway-credentials";

const DEFAULT_API_ORIGIN = "http://127.0.0.1:4000";

function readPairingSecret(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const secret = Buffer.from(value, "base64url");
  return secret.length >= 32 && secret.toString("base64url") === value ? secret : null;
}

function readConfiguration(env: NodeJS.ProcessEnv): { ok: true; value: GatewayConfiguration } | { ok: false; reason: "missing" | "invalid" } {
  const apiOrigin = env.DESKTOP_API_ORIGIN?.trim() || DEFAULT_API_ORIGIN;
  const expectedDomainSchemaRevision = env.ASTELLA_DOMAIN_SCHEMA_REVISION?.trim();
  const configRevision = env.DESKTOP_DEPLOYMENT_CONFIG_REVISION?.trim() || "desktop-dev-config-v1";

  if (!expectedDomainSchemaRevision) return { ok: false, reason: "missing" };

  if (apiOrigin.startsWith("https://")) {
    const parsed = deploymentConfigSchema.safeParse({
      version: 1,
      mode: "remote_https",
      apiOrigin,
      expectedDomainSchemaRevision,
      configRevision,
    });
    return parsed.success ? { ok: true, value: { config: parsed.data, pairingSecret: null } } : { ok: false, reason: "invalid" };
  }

  const pairingKeyId = env.ASTELLA_DESKTOP_PAIRING_KEY_ID?.trim();
  const pairingSecret = readPairingSecret(env.ASTELLA_DESKTOP_PAIRING_SECRET?.trim());
  if (!pairingKeyId || !pairingSecret) return { ok: false, reason: "missing" };

  const parsed = deploymentConfigSchema.safeParse({
    version: 1,
    mode: "local_loopback",
    apiOrigin,
    localServiceTrust: "hmac_pairing_v1",
    expectedServiceId: DESKTOP_API_SERVICE_ID,
    expectedDomainSchemaRevision,
    pairingKeyId,
    configRevision,
  });
  return parsed.success ? { ok: true, value: { config: parsed.data, pairingSecret } } : { ok: false, reason: "invalid" };
}

function retryFor(code: GatewayErrorCode): DesktopGatewayFailure["retry"] {
  if (code === "api_unavailable" || code === "network_timeout") return "safe_retry";
  if (code === "result_unknown") return "resync_first";
  if (code === "api_untrusted" || code === "configuration_error") return "user_action";
  return "never";
}

function parseSseSequence(block: string): number | null {
  const idLine = block.split(/\r?\n/).find((line) => line.startsWith("id:"));
  if (!idLine) return null;
  const value = Number(idLine.slice(3).trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 单帧 payload 的过桥上限：伴星事件体常态 <1KB，超过即视为异常帧丢弃。 */
const COMPANION_CHAT_EVENT_MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * 伴星 SSE 单帧 → 可过桥的最小投影（`companionChatStreamEventV1Schema`）。
 *
 * 主进程是信任边界：畸形 JSON、缺字段、payload 非对象或超限一律返回 null 丢弃，
 * 绝不把原始 SSE 文本转发给渲染层。事件类型不做白名单——DB 允许 18 种，桌面端
 * 只对认识的那几种做事，未知类型照样过桥但不渲染。
 */
export function parseCompanionSseFrame(block: string): CompanionChatStreamEventV1 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const envelope = companionStreamEventV1Schema.safeParse(raw);
  if (!envelope.success) return null;
  const payload = envelope.data.type === "voice.segment.ready"
    ? (({ synthesisText: _privateSynthesisText, ...rendererSafe }) => rendererSafe)(envelope.data.payload)
    : envelope.data.payload;
  if (JSON.stringify(payload).length > COMPANION_CHAT_EVENT_MAX_PAYLOAD_BYTES) return null;
  const parsed = companionChatStreamEventV1Schema.safeParse({
    seq: envelope.data.seq,
    runId: envelope.data.runId,
    generation: envelope.data.generation,
    eventType: envelope.data.type,
    payload,
  });
  return parsed.success ? parsed.data : null;
}

export function parseCompanionAccountSseFrame(block: string): CompanionAccountGlobalOffEventV1 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = companionAccountGlobalOffEventV1Schema.safeParse(JSON.parse(dataLines.join("\n")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Durable inbox frames are validated in main before becoming renderer invalidations. */
export function parseCompanionInboxSseFrame(block: string): AssistantDeliveryV2 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = assistantDeliveryV2Schema.safeParse(JSON.parse(dataLines.join("\n")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function waitForStreamRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * SSE 断线重连的阶梯（0269 轮 M17）。
 *
 * 以前 5 条流（account / inbox / 学习轮 / 制卡 / 伴星对话）在"流自然结束"和"抛错"两条
 * 出口上都写死固定 1000 毫秒：本地 API 一停，主进程就变成每秒最多 5 次
 * 重连，而每一次 `ensureConnected()` 会把整套 HMAC 信任握手 + `/health` 再走一遍——
 * 那正好是服务在恢复期最需要喘息的时候。退避到 30s 封顶，并带 ±25% 抖动，避免五条流
 * 永远在同一毫秒一起撞上去。
 *
 * 归零点在"真的读到一帧"上（见各 watcher 里的 `streamRetryAttempt = 0`）：能收到帧就
 * 说明这条线是通的，不该再背着失败历史。
 */
/** 只为读出一个 `error` token 而碰失败响应的 body，给它一个比任何正常响应都小的上限。 */
const DOMAIN_ERROR_BODY_MAX_BYTES = 4_096;

const STREAM_RETRY_BASE_MS = 1_000;
const STREAM_RETRY_CEILING_MS = 30_000;

function streamRetryDelayMs(attempt: number): number {
  const exponential = Math.min(
    STREAM_RETRY_CEILING_MS,
    STREAM_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 10)),
  );
  // ±25% 抖动：五条流同时断开时不该同时重连。
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

function roomActiveGenerationErrorReason(error: unknown): "upstream_unavailable" | "unsupported_contract" | "permission_denied" | "stale_workspace" | "route_not_available" {
  if (error instanceof DesktopGatewayFailure) {
    if (error.code === "unsupported_contract") return "unsupported_contract";
    if (error.code === "forbidden") return "permission_denied";
    if (error.code === "stale_workspace") return "stale_workspace";
    if (error.code === "route_not_available") return "route_not_available";
  }
  return "upstream_unavailable";
}

export class DesktopGateway {
  /**
   * 传输层。**所有发请求的动作最终都落到它**——`this.transport.request(...)`。
   *
   * 为什么它是字段而不是一堆方法：2026-09-30 用 AST 量过，264 个方法里 188 个调
   * `this.request`，而原来那 25 个状态字段全是 `private`——**类作用域的 private
   * 在 mixin 里拿不到**。所以「按命名空间把方法搬走」必须先把这块状态抽出来。
   * 拆分的顺序与理由见 `desktop-gateway-transport.ts` 的文件头。
   */
  private readonly transport: GatewayTransport;

  /**
   * 伴星桥与投递租约（2026-09-30 从本类搬出，见 `desktop-gateway-companion-bridge.ts`）。
   *
   * 它有**自己的定时续约与世代号**，是一个自成一体的小子系统——继续挂在 200 个成员的
   * 这个类上只会让它更难读。auth 的四个方法（`login` / `register` / `logout` /
   * `reauthenticate`）要调它的清理，**这���搬它的直接原因**。
   */
  private readonly bridge: CompanionBridge;

  /**
   * 伴星桥。**只读**——`desktop-ipc.ts` 通过它登记/撤销「助手此刻在读哪一页」。
   *
   * 与 `gatewayTransport` 同理：外部只该「拿它去调东西」，不该改它的状态。
   * 做成访问器而不是把字段改成 public，是为了让这条界线画出来。
   */
  get companionBridge(): CompanionBridge {
    return this.bridge;
  }

  /**
   * 传输层。**只读**，给 `desktop-ipc.ts` 那些**自由函数**用——
   * 2026-09-30 起有一批命名空间方法不再住在类里（见 `desktop-gateway-ns-*.ts`），
   * 它们的调用点是 `ns_search.getSearchDrift(gateway.transport, …)`。
   *
   * 为什么是访问器而不是把字段改成 public：`transport` 本身**仍然是类内部实现**，
   * 外部只该「拿它去调东西」，不该改它。访问器把这条界线画出来。
   */
  get gatewayTransport(): GatewayTransport {
    return this.transport;
  }
  private readonly noteDocTransport: NoteDocTransport;

  /**
   * 笔记正文的 SSE 传输（2026-09-30 随 `watchNoteDocument` 一起搬成自由函数）。
   *
   * **只读**——`desktop-ipc.ts` 通过它开/停那条长连接。与 `gatewayTransport` 同理：
   * 外部只该拿它去调东西，不该改它。
   */
  get noteDocTransportHandle(): NoteDocTransport {
    return this.noteDocTransport;
  }

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: {
      credentials?: SessionCredentialStore | null;
      guidanceAudioCache?: CompanionGuidanceAudioCache;
      /**
       * 协同传输的实现。默认用真的 Hocuspocus provider；测试里换成假的，才能断言
       * "该不该建这条连接"（门控）与"帧怎么转发"，而不是去连一个真服务端。
       */
      noteDocTransport?: NoteDocTransport;
    } = {},
  ) {
    this.noteDocTransport = options.noteDocTransport ?? defaultNoteDocTransport;
    const result = readConfiguration(env);
    const configuredTrustOrigin = result.ok && result.value.config.mode === "local_loopback"
      ? result.value.config.apiOrigin
      : DEFAULT_API_ORIGIN;
    // `configuration` 与 `connection` 在传输层里是 readonly / 构造期定的，
    // 所以**先在这里算出来，再一起交给 transport**——不在构造里回头写它的字段。
    const configuration = result.ok ? result.value : null;
    const connection: ApiConnectionStateV1 = result.ok
      ? { version: 1, kind: "checking", originKind: result.value.config.mode }
      : {
        version: 1,
        kind: "configuration_error",
        reason: result.reason === "missing" ? "pairing_secret_missing" : "invalid_deployment_config",
      };
    // 2026-09-30 第四刀：`configurationError` 与 `trust` 变成**构造期定**——
    // 原先在构造里「先算再写」，而 `readonly` 字段只能在构造函数体内赋初值。
    const configurationError: "missing" | "invalid" | null = result.ok ? null : result.reason;
    const trust: LocalApiTrustV1 = {
      version: 1,
      state: "untrusted",
      origin: configuredTrustOrigin,
      serviceId: DESKTOP_API_SERVICE_ID,
      transportEpoch: 1,
    };
    this.transport = new GatewayTransport(
      configuration,
      configurationError,
      options.credentials ?? null,
      connection,
      trust,
      options.guidanceAudioCache ?? null,
    );
    this.bridge = new CompanionBridge(this.transport);
  }

  /** 对外的一格。`desktop-ipc.ts` 直接调它——所以它留在类上，实现在传输层。 */
  getConnectionState(): ApiConnectionStateV1 {
    return apiConnectionStateSchema.parse(this.transport.connection);
  }

  getTrust(): LocalApiTrustV1 {
    return localApiTrustSchema.parse(this.transport.trust);
  }

  getDeploymentConfig(): DeploymentConfigV1 | null {
    return this.transport.configuration?.config ?? null;
  }

  getRuntimeSnapshot(windowState: RuntimeSnapshotV1["windowState"], reducedMotion: boolean): RuntimeSnapshotV1 {
    return runtimeSnapshotSchema.parse({
      version: 1,
      contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
      appId: "astella-desktop-client",
      appVersion: this.env.npm_package_version?.trim() || "0.1.0",
      platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
      windowState: windowStateSnapshotV1Schema.parse(windowState),
      apiConnection: this.getConnectionState(),
      nativeCapabilities: this.transport.nativeCapabilities(),
      reducedMotion,
      startupRevision: 1,
      sessionCredential: {
        persistence: this.transport.credentials?.available ? "safe_storage" : "memory",
        stored: this.transport.credentials?.hasStored() ?? false,
      },
    });
  }

  async connect(requestId?: string): Promise<ApiConnectionStateV1> {
    if (!this.transport.configuration) {
      this.transport.connection = {
        version: 1,
        kind: "configuration_error",
        reason: this.transport.configurationError === "missing" ? "pairing_secret_missing" : "invalid_deployment_config",
      };
      throw new DesktopGatewayFailure("configuration_error", retryFor("configuration_error"));
    }

    this.transport.connection = { version: 1, kind: "checking", originKind: this.transport.configuration.config.mode };
    try {
      if (this.transport.configuration.config.mode === "local_loopback") await this.transport.performLocalTrust(this.transport.configuration, requestId);
      else await this.transport.performRemoteHealth(this.transport.configuration.config, requestId);
      return this.getConnectionState();
    } catch (error) {
      if (error instanceof DesktopGatewayFailure) throw error;
      this.transport.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    }
  }

  /** GET /members（Owner）：活跃成员列表。 */
  async listMembers(requestId?: string): Promise<MemberListResultV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/members?limit=200", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as { items?: unknown[]; total?: unknown };
    const parsed = memberListResultV1Schema.safeParse({
      version: 1,
      items: (payload.items ?? []).map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return {
          version: 1,
          userId: row.userId,
          email: row.email,
          role: row.role,
          joinedAt: row.joinedAt,
        };
      }),
      total: payload.total,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** DELETE /members/:userId（Owner）：移除成员，其会话立即失效。 */
  async removeMember(userId: string, requestId?: string): Promise<{ removed: true }> {
    await this.transport.ensureConnected(requestId);
    await this.transport.request(`/members/${userId}`, { method: "DELETE" }, true, true, requestId);
    return { removed: true };
  }

  async getReviewQueue(cursor?: string, limit = 50, requestId?: string): Promise<z.infer<typeof reviewQueueV2Schema>> {
    await this.transport.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursor);
    query.set("limit", String(limit));
    const result = await this.transport.request(`/v2/reviews/queue?${query.toString()}`, { method: "GET" }, true, true, requestId);
    const parsed = reviewQueueV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 方案 16 §18.1 的展示层延后：卡在 deferredUntil 之前不再出现在到期队列，
   * official nextReviewAt 不变。stale（generation 过期/已消费）映射为 conflict。
   */
  async deferReview(
    request: z.infer<typeof reviewDeferRequestV2Schema>,
    requestId?: string,
  ): Promise<z.infer<typeof reviewDeferResultV2Schema>> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/v2/reviews/defer", {
      method: "POST",
      body: JSON.stringify(reviewDeferRequestV2Schema.parse(request)),
    }, true, true, requestId);
    const parsed = reviewDeferResultV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * W7-3 刀三：把一个目标设成「暂不安排」（39 §9.1 行 2）。
   *
   * 请求体在**这一层**先 `parse` 一次再发出去：缺 `noteId` 的那一种在渲染层就红，
   * 不会变成一次从主进程发出去的 400。回执同样 `safeParse`——服务端哪天给
   * `dismissedPendingSchedules` 改名，桌面这一层会先发现，而不是把 `undefined`
   * 念成「撤下了 0 条」。
   */
  async holdObjectiveForReview(
    request: z.infer<typeof objectiveHoldCommandV2Schema>,
    requestId?: string,
  ): Promise<z.infer<typeof objectiveHoldResultV2Schema>> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/v2/reviews/objectives/hold", {
      method: "POST",
      body: JSON.stringify(objectiveHoldCommandV2Schema.parse(request)),
    }, true, true, requestId);
    const parsed = objectiveHoldResultV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * W7-3 刀六：订阅来源**分别**开停（39 §9.1 第一段与规则表行 1）。
   *
   * 两条命令而不是一颗 toggle。回执里的 `stillCoveredBy` 必须 `safeParse` 过——
   * 那一格是屏上「仍由 X 继续安排」那句话的**唯一**出处，缺了它界面会静默念成
   * "已停止安排"，而那张卡明明还开着。
   */
  private async postReviewSubscription(
    path: "/v2/reviews/subscriptions/activate" | "/v2/reviews/subscriptions/pause",
    request: z.infer<typeof reviewSubscriptionCommandV2Schema>,
    requestId?: string,
  ): Promise<z.infer<typeof reviewSubscriptionResultV2Schema>> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(path, {
      method: "POST",
      body: JSON.stringify(reviewSubscriptionCommandV2Schema.parse(request)),
    }, true, true, requestId);
    const parsed = reviewSubscriptionResultV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async activateReviewSubscription(
    request: z.infer<typeof reviewSubscriptionCommandV2Schema>,
    requestId?: string,
  ): Promise<z.infer<typeof reviewSubscriptionResultV2Schema>> {
    return this.postReviewSubscription("/v2/reviews/subscriptions/activate", request, requestId);
  }

  async pauseReviewSubscription(
    request: z.infer<typeof reviewSubscriptionCommandV2Schema>,
    requestId?: string,
  ): Promise<z.infer<typeof reviewSubscriptionResultV2Schema>> {
    return this.postReviewSubscription("/v2/reviews/subscriptions/pause", request, requestId);
  }

  /**
   * 今日复习那三个动作（§12 表「今日复习」行：减量／暂停／恢复）。
   *
   * 回执里那句 `screenLine` **由服务端按真读数生成**，渲染层原样念——渲染层自己拼的
   * 话，迟早有一处忘了带「剩下 N 道」（§12 表「剩余需求不伪称完成」）。
   */
  async actOnTodayBatch(
    request: z.infer<typeof todayBatchOptionCommandV2Schema>,
    requestId?: string,
  ): Promise<z.infer<typeof todayBatchOptionResultV2Schema>> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/v2/home/today-batch/option", {
      method: "POST",
      body: JSON.stringify(request),
    }, true, true, requestId);
    const parsed = todayBatchOptionResultV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 今日复习那一批的**读侧**（§12 表「今日复习」行「一批有限任务，**展示选择原因**」）。
   *
   * ⚠️ 2026-09-30 补上：这一条**端点、preload、组件、共享契约四段都在，唯独网关与主进程
   * 这一段没人写**——`desktop-ipc-channel-coverage` 那道守卫就是为这件事立的，它一直红着
   * （`astella.v1.home.todayBatch.read: expected { Object (unaccounted) }`）。结果是
   * 「今天这一批」在真窗口里**永远读不出来**，屏上只能落进 `TodayBatchSurface` 那个
   * 「今天这一批暂时读不出来」＋「再试一次」的失败分支。
   *
   * `timeZone` **由客户端带上来**（不是网关自己算）：它决定「今天」是哪一天，
   * 按 UTC 算会在她的午夜前后切错一次——而那一次恰好是「她刚做完今天」的时候。
   */
  async readTodayBatch(timeZone: string, requestId?: string): Promise<z.infer<typeof todayBatchWireV2Schema>> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(
      `/v2/home/today-batch?timeZone=${encodeURIComponent(timeZone)}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = todayBatchWireV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listNoteReviewSubscriptions(
    requestId?: string,
  ): Promise<z.infer<typeof noteReviewSubscriptionsV2Schema>> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/v2/reviews/subscriptions/notes", { method: "GET" }, true, true, requestId);
    const parsed = noteReviewSubscriptionsV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * W7-3 刀三：「恢复此目标并开启」（39 §9.1 行 3）。
   *
   * 409（`still_held`）**不**在这里翻成成功：那一格意味着同一目标上还有另一条
   * 活着的排除，屏上要念的是「这个目标仍在暂不安排中」，不是「已开启」。
   */
  async resumeObjectiveForReview(
    request: z.infer<typeof objectiveResumeCommandV2Schema>,
    requestId?: string,
  ): Promise<z.infer<typeof objectiveResumeResultV2Schema>> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/v2/reviews/objectives/resume", {
      method: "POST",
      body: JSON.stringify(objectiveResumeCommandV2Schema.parse(request)),
    }, true, true, requestId);
    const parsed = objectiveResumeResultV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 「今日学习」操作日志流（页 14 重构）。窗口由渲染层的本地日历日锚点给出；
   * 服务端只做权威表投影，网关这里只校验合同形状。
   */
  async getTodayActivity(
    from: string | undefined,
    to: string | undefined,
    requestId?: string,
  ): Promise<z.infer<typeof todayActivityV1Schema>> {
    await this.transport.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (from !== undefined && from !== "") query.set("from", from);
    if (to !== undefined && to !== "") query.set("to", to);
    const result = await this.transport.request(`/activity/today?${query.toString()}`, { method: "GET" }, true, true, requestId);
    const parsed = todayActivityV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 「全部空间」统计：当前账号在每个活跃空间里的同一份数字 + 合计。
   *
   * 与 `/stats/overview` 的关系：那条读的是**当前空间**（网关只持一个
   * `this.transport.token`，空间由令牌决定），所以界面上那些"我的"数字其实只是"这个
   * 空间的"。这条按账号扇出，用来把被空间切开的个人进度并排摆出来。形状校验
   * 在这里做，与邻居同一条：解析失败按 unsupported_contract 交给上层，不猜字段。
   */
  async getAllWorkspacesStatsOverview(requestId?: string): Promise<AllWorkspacesStatsOverviewV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/stats/overview/all", { method: "GET" }, true, true, requestId);
    const parsed = allWorkspacesStatsOverviewSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listObjectives(options: { lifecycle?: "active" | "archived" | "superseded"; cursor?: string; limit?: number; noteId?: string } = {}, requestId?: string): Promise<ObjectiveListPageV3> {
    await this.transport.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (options.lifecycle) query.set("lifecycle", options.lifecycle);
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.noteId) query.set("noteId", options.noteId);
    const suffix = query.toString();
    const result = await this.transport.request(`/v2/learning-objectives${suffix ? `?${suffix}` : ""}`, { method: "GET" }, true, true, requestId);
    const parsed = objectiveListPageV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getObjective(objectiveId: string, requestId?: string): Promise<LearningObjectiveSurfaceV3> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(`/v2/learning-objectives/${safeUuid(objectiveId)}`, { method: "GET" }, true, true, requestId);
    const parsed = learningObjectiveSurfaceV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 「先看笔记」那一发（39d W5-4；PRD §7.1、§16.24）。
   *
   * **它是一次暴露记账，不是导航**：界面自己跳去笔记页，这一发只保证
   * 「读过正文」这件事落进 `learning_exposures_v2`。回执整份过合同——
   * `conditionsAfter` 与 `userFacingLabel` 是屏上那句话的来源，形状漂了要在这里红。
   */
  async recordRecallSourceReveal(
    input: { objectiveId: string; waitingKind: RecallWaitingKindV1; idempotencyKey: string },
    requestId?: string,
  ): Promise<RecordRecallSourceRevealResultV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(
      "/v2/v2/reviews/recall-source-reveal",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, version: 2 }),
      },
      true,
      true,
      requestId,
    );
    if (result.status >= 300) throw this.transport.mapResponseError(result.status, result.headers);
    const parsed = recordRecallSourceRevealResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getUnderstandingTopology(requestId?: string): Promise<NoteDeepeningSnapshotV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/v3/understanding/topology", { method: "GET" }, true, true, requestId);
    const parsed = understandingTopologySnapshotV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 记一次本人对建议关系的表态（39d W8-2；§11.3、§16.20）。
   *
   * **只写本人那一行**：不改公共 relations、不改 lifecycle、不产生学习记录或复习安排，
   * 别人的视图里读不到这一下（§11.3「用户确认首先只影响本人的学习视图；写入共享关系
   * 需具备材料编辑权并明确作用范围」）。
   *
   * 幂等那一条由服务端判并回 304；这里**不**把 304 当失败转成异常——用户重复点一次
   * 「确认」不该在审计里留两条记录，也不该让屏上弹一个错。
   */
  async setPersonalRelationDecision(input: {
    fromObjectiveId: string;
    toObjectiveId: string;
    relation: PersonalRelationKindV2Wire;
    decision: PersonalRelationDecisionV2;
    noteId?: string;
  }, requestId?: string): Promise<SetPersonalRelationDecisionV2Result | { unchanged: true }> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/v3/understanding/relation-decisions", {
      method: "POST",
      body: JSON.stringify({ ...input, evidence: {} }),
    }, true, true, requestId, undefined, true);
    if (result.status === 304) return { unchanged: true };
    const parsed = setPersonalRelationDecisionV2ResultSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 星图三层展开的层二与层三（39d W8-1、W8-3；§11.2）。
   *
   * **按一篇笔记读，不复用 `getUnderstandingTopology`**：拓扑那一份回答"图上有哪些
   * 节点"，这一份回答"沿着一篇笔记往下读会依次看到什么"；§11.5「总览只显示当前层，
   * 局部按需加载」。合在一起就是每一次读星图都把每一篇笔记的作答与反馈搬一遍。
   *
   * `limit` 不给就**不给**——本进程不替她决定这一屏看几条（补一个默认值会让服务端
   * 那句"截断了"变成一个客户端挑的数）。
   */
  async getUnderstandingNoteDeepening(input: {
    noteId: string;
    limit?: number;
  }, requestId?: string): Promise<NoteDeepeningV3> {
    await this.transport.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.toString();
    const result = await this.transport.request(
      `/v3/understanding/notes/${encodeURIComponent(input.noteId)}/deepening${suffix ? `?${suffix}` : ""}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = noteDeepeningV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getRoomProjection(requestId?: string): Promise<RoomProjectionV1> {
    await this.transport.ensureConnected(requestId);
    let capabilityProjection: CapabilityProjectionV1 | null = null;
    try {
      capabilityProjection = await ns_source.getCapabilities(this.gatewayTransport, requestId);
    } catch {
      // Dashboard content remains useful when the independent capability
      // projection is degraded. The adapter marks affected actions and
      // capture as unavailable instead of dropping the whole home snapshot.
    }
    const generationRecoveryEnabled = capabilityProjection?.actionCapabilities["card_generation.start"] === "allowed"
      && capabilityProjection.featureAvailability.card_generation_v2.state === "enabled";
    let activeGenerationSummary: CardGenerationActiveSummaryV1[] = [];
    let activeGenerationSummaryError: Parameters<typeof projectLearningDashboardToRoomProjection>[1]["activeGenerationSummaryError"];
    if (generationRecoveryEnabled) {
      try {
        const active = await this.getActiveCardGenerationSummaries(requestId);
        activeGenerationSummary = active.items;
      } catch (error) {
        activeGenerationSummaryError = roomActiveGenerationErrorReason(error);
      }
    }
    const cached = this.transport.roomProjectionCache?.workspaceEpoch === this.transport.workspaceEpoch
      ? this.transport.roomProjectionCache
      : null;
    const headers = cached ? { "If-None-Match": cached.etag } : undefined;
    const result = await this.transport.request(
      "/v2/learning-dashboard",
      { method: "GET", ...(headers ? { headers } : {}) },
      true,
      false,
      requestId,
      undefined,
      true,
    );
    if (result.status === 304) {
      if (!cached) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      // Dashboard content is unchanged, but capability and recovery reads are
      // independent. Re-project the cached dashboard so their latest state is
      // never hidden behind the dashboard ETag.
      const refreshed = roomProjectionV1Schema.parse(projectLearningDashboardToRoomProjection(
        cached.dashboard,
        {
          workspaceEpoch: this.transport.workspaceEpoch,
          enabledRoutes: desktopRouteKindM2Values,
          capabilityProjection,
          activeGenerationSummary,
          ...(activeGenerationSummaryError ? { activeGenerationSummaryError } : {}),
        },
      ));
      this.transport.roomProjectionCache = { ...cached, value: refreshed };
      return refreshed;
    }
    if (result.status < 200 || result.status >= 300) {
      throw this.transport.mapResponseError(result.status, result.headers);
    }
    const dashboard = learningDashboardV2Schema.safeParse(result.body);
    if (!dashboard.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    const projection = roomProjectionV1Schema.parse(projectLearningDashboardToRoomProjection(
      dashboard.data,
      {
        workspaceEpoch: this.transport.workspaceEpoch,
        enabledRoutes: desktopRouteKindM2Values,
        capabilityProjection,
        activeGenerationSummary,
        ...(activeGenerationSummaryError ? { activeGenerationSummaryError } : {}),
      },
    ));
    const etag = result.headers.get("etag")?.trim() || `"${dashboard.data.dashboardRevision}"`;
    this.transport.roomProjectionCache = { etag, workspaceEpoch: this.transport.workspaceEpoch, dashboard: dashboard.data, value: projection };
    return projection;
  }

  async renewCompanionRuntimeFence(
    surfaceEpoch: number,
    ttlSeconds = 120,
    requestId?: string,
  ): Promise<RuntimeFenceResponse> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(
      "/me/companion/runtime-fences",
      {
        method: "POST",
        body: JSON.stringify({
          deviceSessionId: this.transport.deviceSessionId,
          surfaceEpoch,
          ttlSeconds,
        }),
      },
      true,
      true,
      requestId,
    );
    const parsed = runtimeFenceResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** Main-only account epoch stream. Raw SSE and device identity never cross preload. */
  async watchCompanionAccountEvents(
    afterEpoch: number,
    onEvent: (event: CompanionAccountGlobalOffEventV1) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.transport.ensureConnected();
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(afterEpoch) && afterEpoch >= 0 ? afterEpoch : 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };
    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.transport.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.transport.token) headers.set("Authorization", `Bearer ${this.transport.token}`);
          const userId = this.transport.currentSession?.status === "authenticated" ? this.transport.currentSession.user.userId : null;
          if (cursor > 0 && userId) headers.set("Last-Event-ID", `${userId}:${cursor}`);
          const url = new URL("/me/companion/events", `${configuration.config.apiOrigin}/`);
          url.searchParams.set("after", String(cursor));
          const response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
          if (response.status >= 300 && response.status < 400) throw new DesktopGatewayFailure("api_untrusted", "user_action");
          if (!response.ok) throw this.transport.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const event = parseCompanionAccountSseFrame(block);
              if (!event || event.epoch <= cursor) continue;
              cursor = event.epoch;
              await onEvent(event);
            }
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  /**
   * Main-owned durable proactive inbox stream. The renderer receives only a
   * sequence invalidation and re-reads the strict timeline projection.
   */
  async watchCompanionInboxEvents(
    afterSequence: number,
    onDelivery: (delivery: AssistantDeliveryV2) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.transport.ensureConnected();
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };
    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.transport.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.transport.token) headers.set("Authorization", `Bearer ${this.transport.token}`);
          if (cursor > 0) headers.set("Last-Event-ID", String(cursor));
          const url = new URL("/companion/deliveries/inbox/stream", `${configuration.config.apiOrigin}/`);
          url.searchParams.set("after", String(cursor));
          const response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
          if (response.status >= 300 && response.status < 400) throw new DesktopGatewayFailure("api_untrusted", "user_action");
          if (!response.ok) throw this.transport.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const delivery = parseCompanionInboxSseFrame(block);
              if (!delivery || delivery.inboxSequence <= cursor) continue;
              cursor = delivery.inboxSequence;
              await onDelivery(delivery);
            }
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  /** 候选记忆确认：服务端同一事务里写长期记忆并抬高 familiarity。 */
  async confirmCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("confirm", memoryId, requestId);
  }

  async pinCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("pin", memoryId, requestId);
  }

  async unpinCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("unpin", memoryId, requestId);
  }

  async archiveCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("archive", memoryId, requestId);
  }

  async restoreCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("restore", memoryId, requestId);
  }

  /**
   * 从 30 天回收区恢复（40 §11「删除可撤回」）。
   *
   * 走 `POST /:id/restore-deleted` 而不是既有的 `restore`：后者恢复的是**归档**，
   * 前者恢复的是**已删除**。两者都叫 restore，但一个撤归档、一个撤删除——
   * 混用会让用户以为删掉的东西回来了，实际只是从归档区回来。
   */

  /**
   * 彻底清除（不可逆，40 §11「不以『正式历史不可变』拒绝适用的删除规则」）。
   *
   * 与 `removeCompanionMemory`（进回收区，等 30 天）的分工是**时间**：
   * 那条是默认，那条是「现在就删干净」。所以这里不给"撤销"留位置。
   */

  private async mutateCompanionMemory(
    action: "confirm" | "pin" | "unpin" | "archive" | "restore",
    memoryId: string,
    requestId?: string,
  ): Promise<CompanionMemoryItemV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(
      `/companion/memory/${safeUuid(memoryId)}/${action}`,
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  private async getActiveCardGenerationSummaries(requestId?: string): Promise<CardGenerationActiveSummaryListV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(
      "/v2/card-generation-runs/active",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = cardGenerationActiveSummaryListV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async watchLearningRunEvents(
    runId: string,
    onSequence: (sequence: number) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.transport.ensureConnected();
    const safeRunId = safeUuid(runId);
    // Bind the main-owned stream to the same strict V2 snapshot used by the
    // query/command paths. An unknown snapshot fails closed before
    // any raw SSE payload can reach the renderer bridge.
    const streamSnapshot = await ns_learning.getLearningRun(this.gatewayTransport, safeRunId);
    const controller = new AbortController();
    let closed = false;
    let cursor = 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };

    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.transport.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.transport.token) headers.set("Authorization", `Bearer ${this.transport.token}`);
          if (cursor > 0) headers.set("Last-Event-ID", String(cursor));
          const eventsUrl = new URL(`/learning-runs/${safeRunId}/events`, `${configuration.config.apiOrigin}/`);
          eventsUrl.searchParams.set("snapshotId", streamSnapshot.snapshotId);
          const response = await fetch(eventsUrl, {
            method: "GET",
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status >= 300 && response.status < 400) {
            throw new DesktopGatewayFailure("api_untrusted", "user_action");
          }
          if (!response.ok) throw this.transport.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const sequence = parseSseSequence(block);
              if (sequence !== null && sequence > cursor) {
                cursor = sequence;
                await onSequence(sequence);
              }
            }
          }
          buffer += decoder.decode();
          const sequence = parseSseSequence(buffer);
          if (sequence !== null && sequence > cursor) {
            cursor = sequence;
            await onSequence(sequence);
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  async watchCardGenerationEvents(
    runId: string,
    onSequence: (sequence: number) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.transport.ensureConnected();
    const safeRunId = safeUuid(runId);
    const controller = new AbortController();
    let closed = false;
    let cursor = 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };

    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.transport.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.transport.token) headers.set("Authorization", `Bearer ${this.transport.token}`);
          if (cursor > 0) headers.set("Last-Event-ID", String(cursor));
          const response = await fetch(new URL(`/v2/card-generation-runs/${safeRunId}/events/stream`, `${configuration.config.apiOrigin}/`), {
            method: "GET",
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status >= 300 && response.status < 400) {
            throw new DesktopGatewayFailure("api_untrusted", "user_action");
          }
          if (!response.ok) throw this.transport.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const sequence = parseSseSequence(block);
              if (sequence !== null && sequence > cursor) {
                cursor = sequence;
                await onSequence(sequence);
              }
            }
          }
          buffer += decoder.decode();
          const sequence = parseSseSequence(buffer);
          if (sequence !== null && sequence > cursor) {
            cursor = sequence;
            await onSequence(sequence);
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  /**
   * 伴星会话事件流（§5.3）：`GET /companion/conversations/:id/events`。
   *
   * 与 learningRun/cardGeneration 两条流同构（NOTIFY 唤醒 + 兜底轮询由服务端负责），
   * 区别是这里转发**事件本身**而不是"有新版本了"的信号：回复的渐进显现与逐句开口
   * 要求帧到即渲染，再让渲染层回查一次消息等于把流式的收益原路还回去。
   *
   * `eventCursor` 是订阅起点（seq 独占），来自回合响应的 `eventCursor`——从
   * turn.accepted 之后开始收，不重放历史。断线以 `Last-Event-ID` 续传；
   * 400/409（游标落在过期窗口）只允许重置为 0 重放一次，再失败即停流并报错，
   * 由渲染层的消息快照兜底。
   */
  async watchCompanionConversationEvents(
    conversationId: string,
    eventCursor: number,
    onEvent: (event: CompanionChatStreamEventV1) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.transport.ensureConnected();
    const safeConversationId = safeUuid(conversationId);
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(eventCursor) && eventCursor >= 0 ? eventCursor : 0;
    let resetOnce = false;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };

    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.transport.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.transport.token) headers.set("Authorization", `Bearer ${this.transport.token}`);
          // 服务端 cursor 取合法较大值：query `after` 与 Last-Event-ID 并存时以
          // 大者为准（§5.3），两者给同一个值即可。
          if (cursor > 0) headers.set("Last-Event-ID", `${safeConversationId}:${cursor}`);
          const eventsUrl = new URL(
            `/companion/conversations/${safeConversationId}/events`,
            `${configuration.config.apiOrigin}/`,
          );
          eventsUrl.searchParams.set("after", String(cursor));
          const response = await fetch(eventsUrl, {
            method: "GET",
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status === 400 || response.status === 409) {
            // INVALID_CURSOR / CURSOR_EXPIRED：窗口已过期，只能从头重放一次。
            // 渲染层按 runId/generation 过滤，重放不会污染当前回合的呈现。
            if (resetOnce) throw this.transport.mapResponseError(response.status, response.headers);
            resetOnce = true;
            cursor = 0;
            continue;
          }
          if (response.status >= 300 && response.status < 400) {
            throw new DesktopGatewayFailure("api_untrusted", "user_action");
          }
          if (!response.ok) throw this.transport.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const event = parseCompanionSseFrame(block);
              if (!event || event.seq <= cursor) continue;
              cursor = event.seq;
              await onEvent(event);
            }
          }
          buffer += decoder.decode();
          const tail = parseCompanionSseFrame(buffer);
          if (tail && tail.seq > cursor) {
            cursor = tail.seq;
            await onEvent(tail);
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }
}
