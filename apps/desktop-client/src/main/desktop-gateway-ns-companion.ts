/**
 * 网关的「伴星」那一族 —— **2026-09-30 从 `DesktopGateway` 类搬出**。
 *
 * ## 它为什么现在能搬
 *
 * AST 实测：52 个通道方法 + 1 个专属助手，对类状态的依赖**只剩那个助手**——
 * 其余全在 `GatewayTransport` / `CompanionBridge` 上了（前十九刀搬过去的）。
 * **十个命名空间搬完之后，伴星是最后一块大的。**
 *
 * 下面**逐字搬移**：成员由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts`
 * 切出，只做三处改写——签名前加 `t: GatewayTransport`、`this.transport.` 换成 `t.`、
 * 同族方法互相调用改成直接按函数名。
 */
const companionActivityTimelineWireSchema = z.strictObject({
  items: z.array(assistantDeliveryV2Schema.extend({ expired: z.boolean() })).max(100),
  nextCursor: z.number().int().min(0),
  serverTime: z.string().datetime({ offset: true }),
});

import { assistantDeliveryV2Schema } from "@ailearn/shared/companion-bridge-contracts";
import { z } from "zod";
import { projectCompanionDelivery } from "./desktop-gateway-companion-bridge";
import {  DesktopGatewayFailure,
} from "./desktop-gateway-failure";
import {  GatewayTransport as GatewayTransportContract,
} from "./desktop-gateway-transport";
import {  safeUuid,
} from "./desktop-gateway-uuid";
import {  CompanionAgentRoutesListRequestV1,
  CompanionAgentRoutesListResultV1,
  CompanionChatCancelRunRequestV1,
  CompanionChatCancelRunResultV1,
  CompanionChatEnsureRequestV1,
  CompanionChatEnsureResultV1,
  CompanionChatListMessagesRequestV1,
  CompanionChatListMessagesResultV1,
  CompanionChatOpenThoughtRequestV1,
  CompanionChatOpenThoughtResultV1,
  CompanionChatProposalDecideRequestV1,
  CompanionChatProposalDecideResultV1,
  CompanionChatProposalGetRequestV1,
  CompanionChatProposalGetResultV1,
  CompanionChatSendTurnRequestV1,
  CompanionChatSendTurnResultV1,
  CompanionRunNodesListRequestV1,
  CompanionRunNodesListResultV1,
  companionAgentRoutesListResultV1Schema,
  companionChatCancelRunResultV1Schema,
  companionChatEnsureResultV1Schema,
  companionChatListMessagesResultV1Schema,
  companionChatOpenThoughtResultV1Schema,
  companionChatProposalDecideResultV1Schema,
  companionChatProposalGetResultV1Schema,
  companionChatSendTurnResultV1Schema,
  companionRunNodesListResultV1Schema,
} from "@ailearn/shared/companion-chat-desktop-contracts";
import {  CompanionGroundedTutorGrantV1,
  CompanionLearningContextV1,
  CompanionLearningRunContextV1,
  CreateCompanionLearningRunContextGrantRequestV1,
  companionConversationV1Schema,
  companionGroundedTutorGrantV1Schema,
  companionLearningContextV1Schema,
  companionLearningRunContextV1Schema,
} from "@ailearn/shared/companion-conversation-contracts";
import {  CompanionHomeProjectionV1,
  CompanionRoomProfilePatchV1,
  CompanionRoomProfileV1,
  companionHomeProjectionV1Schema,
  companionRoomProfileV1Schema,
} from "@ailearn/shared/companion-home-contracts";
import {  CompanionInvitationActionRequest,
  CompanionInvitationV2,
  CompanionJourneyActionRequest,
  CompanionJourneyBootstrap,
  CompanionJourneyV2,
  companionInvitationSchema,
  companionJourneyBootstrapSchema,
  companionJourneySchema,
} from "@ailearn/shared/companion-journey-contracts";
import {  CompanionActivityTimelineV1,
  CompanionAuditDeleteResultV1,
  CompanionDailyMonthV1,
  CompanionDailySummaryV1,
  CompanionHistoryClearResultV1,
  CompanionHistoryPageV1,
  CompanionHistoryQueryV1,
  CompanionHistorySearchQueryV1,
  CompanionHistorySearchV1,
  CompanionMemoryCorrectInputV1,
  CompanionMemoryCreateInputV1,
  CompanionMemoryItemV1,
  CompanionMemoryListQuery,
  CompanionMemoryListV1,
  CompanionMemoryStarMapV2,
  CompanionPersonaMutationV1,
  CompanionPersonaPatchV1,
  CompanionPersonaResetV1,
  CompanionPersonaV1,
  companionActivityTimelineV1Schema,
  companionAuditDeleteResultV1Schema,
  companionDailyMonthV1Schema,
  companionDailySummaryV1Schema,
  companionHistoryClearResultV1Schema,
  companionHistoryPageV1Schema,
  companionHistorySearchV1Schema,
  companionMemoryClearResultV1Schema,
  companionMemoryConflictListV1Schema,
  companionMemoryConflictResolveResultV1Schema,
  companionMemoryItemV1Schema,
  companionMemoryListV1Schema,
  companionMemoryQueueResultV1Schema,
  companionMemoryStarMapV2Schema,
  companionPersonaMutationV1Schema,
  companionPersonaResetV1Schema,
  companionPersonaV1Schema,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import {  CompanionAccountPatch,
  CompanionAccountStateV1,
  CompanionOverview,
  OnboardingTransitionRequest,
  OnboardingTransitionResponse,
  companionAccountStateV1Schema,
  companionAnswerModePreferenceV1Schema,
  companionOverviewSchema,
  companionVoicePreferenceV1Schema,
  onboardingTransitionResponseSchema,
} from "@ailearn/shared/companion-shell-contracts";
import {  COMPANION_VOICE_SPEAK_VOICE,
  COMPANION_VOICE_TRANSCRIBE_MAX_AUDIO_BYTES,
  CompanionVoicePlaybackOutcomeRequestV1,
  CompanionVoicePlaybackOutcomeResultV1,
  CompanionVoiceSpeakRequestV1,
  CompanionVoiceSpeakResultV1,
  CompanionVoiceSpeakSegmentRequestV2,
  CompanionVoiceTranscribeRequestV1,
  CompanionVoiceTranscribeResultV1,
  companionVoicePlaybackOutcomeResultV1Schema,
  companionVoiceSpeakResultV1Schema,
  companionVoiceTranscribeResultV1Schema,
} from "@ailearn/shared/companion-voice-contracts";
import {  uuidSchema,
} from "@ailearn/shared/desktop-ipc-contracts";
import {  TtsEngineV1,
} from "@ailearn/shared/tts-voice-catalog";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function actOnCompanionInvitation(t: GatewayTransport, 
    request: CompanionInvitationActionRequest,
    requestId?: string,
  ): Promise<CompanionInvitationV2> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/invitation/actions",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionInvitationSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function actOnCompanionJourney(t: GatewayTransport, 
    journeyId: string,
    request: CompanionJourneyActionRequest,
    requestId?: string,
  ): Promise<CompanionJourneyV2> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/journeys/${safeUuid(journeyId)}/actions`,
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionJourneySchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function cancelCompanionChatRun(t: GatewayTransport, 
    request: CompanionChatCancelRunRequestV1,
    requestId?: string,
  ): Promise<CompanionChatCancelRunResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/runs/${request.runId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ version: 1, generation: request.generation, reason: "user" }),
      },
      true,
      true,
      requestId,
    );
    const parsed = companionChatCancelRunResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function clearCompanionHistory(t: GatewayTransport, requestId?: string): Promise<CompanionHistoryClearResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/history",
      { method: "DELETE" },
      true,
      true,
      requestId,
    );
    const parsed = companionHistoryClearResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function clearCompanionMemories(t: GatewayTransport, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request("/companion/memory", { method: "DELETE" }, true, true, requestId);
    const parsed = companionMemoryClearResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function correctCompanionMemory(t: GatewayTransport, memoryId: string, request: CompanionMemoryCorrectInputV1, requestId?: string): Promise<CompanionMemoryItemV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/memory/${safeUuid(memoryId)}/correct`,
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function createCompanionLearningRunContextGrant(t: GatewayTransport, 
    runId: string,
    request: CreateCompanionLearningRunContextGrantRequestV1,
    requestId?: string,
  ): Promise<CompanionGroundedTutorGrantV1> {
    await t.ensureConnected(requestId);
    const safeRunId = uuidSchema.parse(runId);
    const result = await t.request(
      `/learning-runs/${safeRunId}/companion-context-grants`,
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionGroundedTutorGrantV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function createCompanionMemory(t: GatewayTransport, request: CompanionMemoryCreateInputV1, requestId?: string): Promise<CompanionMemoryItemV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/memory",
      { method: "POST", body: JSON.stringify({ ...request, userStated: true, candidate: false, sourceType: "user_stated" }) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function decideCompanionChatProposal(t: GatewayTransport, 
    request: CompanionChatProposalDecideRequestV1,
    requestId?: string,
  ): Promise<CompanionChatProposalDecideResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/proposals/${request.proposalId}/decision`,
      {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          proposalId: request.proposalId,
          decision: request.decision,
          idempotencyKey: request.idempotencyKey,
          expectedPayloadSha256: request.expectedPayloadSha256,
        }),
        headers: { "Idempotency-Key": request.idempotencyKey },
      },
      true,
      true,
      requestId,
    );
    const parsed = companionChatProposalDecideResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function deleteCompanionAudit(t: GatewayTransport, requestId?: string): Promise<CompanionAuditDeleteResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/me/companion/audit", { method: "DELETE" }, true, true, requestId);
    const parsed = companionAuditDeleteResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function deleteCompanionMemory(t: GatewayTransport, 
    memoryId: string,
    requestId?: string,
  ): Promise<{ readonly memoryItemId: string }> {
    await t.ensureConnected(requestId);
    const id = safeUuid(memoryId);
    await t.request(`/companion/memory/${id}`, { method: "DELETE" }, true, true, requestId);
    return { memoryItemId: id };
  }

export async function dismissCompanionMemory(t: GatewayTransport, memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/memory/${safeUuid(memoryId)}/dismiss`,
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function ensureCompanionConversation(t: GatewayTransport, 
    _request: CompanionChatEnsureRequestV1,
    requestId?: string,
  ): Promise<CompanionChatEnsureResultV1> {
    await t.ensureConnected(requestId);
    const ensureResult = await t.request(
      "/companion/inbox/ensure",
      { method: "POST", body: "{}" },
      true,
      true,
      requestId,
    );
    const conversation = companionConversationV1Schema.safeParse(ensureResult.body);
    if (!conversation.success || conversation.data.kind !== "inbox") {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    const parsed = companionChatEnsureResultV1Schema.safeParse({
      version: 1,
      conversation: conversation.data,
      created: ensureResult.status === 201,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getAnswerModePreference(t: GatewayTransport, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request("/me/companion/answer-mode-preference", { method: "GET" }, true, true, requestId);
    const parsed = companionAnswerModePreferenceV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionAccountOverview(t: GatewayTransport, requestId?: string): Promise<CompanionOverview> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/me/companion",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionOverviewSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionChatProposal(t: GatewayTransport, 
    request: CompanionChatProposalGetRequestV1,
    requestId?: string,
  ): Promise<CompanionChatProposalGetResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/proposals/${request.proposalId}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionChatProposalGetResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionDailyMonth(t: GatewayTransport, month: string, requestId?: string): Promise<CompanionDailyMonthV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/daily/month?month=${encodeURIComponent(month)}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionDailyMonthV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionDailySummary(t: GatewayTransport, date?: string, requestId?: string): Promise<CompanionDailySummaryV1> {
    await t.ensureConnected(requestId);
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    const suffix = params.toString();
    const result = await t.request(
      `/companion/daily${suffix ? `?${suffix}` : ""}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionDailySummaryV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionHomeProjection(t: GatewayTransport, requestId?: string): Promise<CompanionHomeProjectionV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/home-projection",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionHomeProjectionV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionJourney(t: GatewayTransport, 
    journeyId: string,
    requestId?: string,
  ): Promise<CompanionJourneyV2> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/journeys/${safeUuid(journeyId)}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionJourneySchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionJourneyBootstrap(t: GatewayTransport, requestId?: string): Promise<CompanionJourneyBootstrap> {
    await t.ensureConnected(requestId);
    const result = await t.request("/companion/journey/bootstrap", { method: "GET" }, true, true, requestId);
    const parsed = companionJourneyBootstrapSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionLearningContext(t: GatewayTransport, requestId?: string): Promise<CompanionLearningContextV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/learning-context",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionLearningContextV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionLearningRunContext(t: GatewayTransport, 
    runId: string,
    requestId?: string,
  ): Promise<CompanionLearningRunContextV1> {
    await t.ensureConnected(requestId);
    const safeRunId = uuidSchema.parse(runId);
    const result = await t.request(
      `/learning-runs/${safeRunId}/companion-context`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionLearningRunContextV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionMemoryStarMap(t: GatewayTransport, requestId?: string): Promise<CompanionMemoryStarMapV2> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/memory/star-map",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryStarMapV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionPersona(t: GatewayTransport, requestId?: string): Promise<CompanionPersonaV1> {    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/pet-profile",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionPersonaV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionRoomProfile(t: GatewayTransport, requestId?: string): Promise<CompanionRoomProfileV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/room-profile",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionRoomProfileV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCompanionVoicePreference(t: GatewayTransport, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request("/voice/preference", { method: "GET" }, true, true, requestId);
    const parsed = companionVoicePreferenceV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listCompanionActivityTimeline(t: GatewayTransport, 
    before?: number,
    requestId?: string,
  ): Promise<CompanionActivityTimelineV1> {
    await t.ensureConnected(requestId);
    const cursor = before && before > 0 ? `&before=${Math.trunc(before)}` : "";
    const result = await t.request(
      `/companion/deliveries/timeline?limit=50${cursor}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionActivityTimelineWireSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return companionActivityTimelineV1Schema.parse({
      version: 1,
      items: parsed.data.items.map(projectCompanionDelivery),
      nextCursor: parsed.data.nextCursor,
      serverTime: parsed.data.serverTime,
    });
  }

export async function listCompanionAgentRoutes(t: GatewayTransport, 
    request: CompanionAgentRoutesListRequestV1,
    requestId?: string,
  ): Promise<CompanionAgentRoutesListResultV1> {
    await t.ensureConnected(requestId);
    const after = request.afterSeq != null ? String(request.afterSeq) : "0";
    const result = await t.request(
      `/companion/conversations/${request.conversationId}/agent-routes?after=${after}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionAgentRoutesListResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listCompanionChatMessages(t: GatewayTransport, 
    request: CompanionChatListMessagesRequestV1,
    requestId?: string,
  ): Promise<CompanionChatListMessagesResultV1> {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (request.limit != null) query.set("limit", String(request.limit));
    if (request.beforeSeq != null) query.set("beforeSeq", String(request.beforeSeq));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const result = await t.request(
      `/companion/conversations/${request.conversationId}/messages${suffix}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionChatListMessagesResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listCompanionHistory(t: GatewayTransport, 
    query: CompanionHistoryQueryV1 = {},
    requestId?: string,
  ): Promise<CompanionHistoryPageV1> {
    await t.ensureConnected(requestId);
    const params = new URLSearchParams();
    if (query.before) params.set("before", query.before);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.toString();
    const result = await t.request(
      `/companion/history${suffix ? `?${suffix}` : ""}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionHistoryPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listCompanionMemories(t: GatewayTransport, 
    query: CompanionMemoryListQuery = {},
    requestId?: string,
  ): Promise<CompanionMemoryListV1> {
    await t.ensureConnected(requestId);
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.q) params.set("q", query.q);
    if (query.scope) params.set("scope", query.scope);
    if (query.includeCandidates) params.set("includeCandidates", "true");
    if (query.includeArchived) params.set("includeArchived", "true");
    const suffix = params.toString();
    const result = await t.request(
      `/companion/memory${suffix ? `?${suffix}` : ""}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryListV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listCompanionMemoryConflicts(t: GatewayTransport, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request("/companion/memory/conflicts", { method: "GET" }, true, true, requestId);
    const parsed = companionMemoryConflictListV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listCompanionRunNodes(t: GatewayTransport, 
    request: CompanionRunNodesListRequestV1,
    requestId?: string,
  ): Promise<CompanionRunNodesListResultV1> {
    await t.ensureConnected(requestId);
    const after = request.afterSeq != null ? String(request.afterSeq) : "0";
    const result = await t.request(
      `/companion/conversations/${request.conversationId}/run-nodes?after=${after}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionRunNodesListResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function openCompanionExport(t: GatewayTransport, 
    kind: "all" | "memory" | "audit",
    requestId?: string,
  ): Promise<Response> {
    await t.ensureConnected(requestId);
    const configuration = t.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const path = kind === "all" ? "/companion/export"
      : kind === "memory" ? "/companion/memory/export"
        : "/me/companion/audit/export";
    const headers = new Headers({ Accept: kind === "all" ? "application/x-ndjson" : "application/json" });
    if (t.token) headers.set("Authorization", `Bearer ${t.token}`);
    let response: Response;
    try {
      response = await fetch(new URL(path, `${configuration.config.apiOrigin}/`), {
        method: "GET",
        headers,
        redirect: "manual",
      });
    } catch {
      t.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    if (!response.ok) throw t.mapResponseError(response.status, response.headers);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const expected = kind === "all" ? "application/x-ndjson" : "application/json";
    if (!contentType.startsWith(expected) || !response.body) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return response;
  }

export async function openCompanionThought(t: GatewayTransport, 
    request: CompanionChatOpenThoughtRequestV1,
    requestId?: string,
  ): Promise<CompanionChatOpenThoughtResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/thoughts/${request.thoughtId}/open`,
      { method: "POST", body: JSON.stringify({ version: 1 }) },
      true,
      true,
      requestId,
    );
    const parsed = companionChatOpenThoughtResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function patchCompanionAccountState(t: GatewayTransport, 
    request: CompanionAccountPatch,
    requestId?: string,
  ): Promise<CompanionAccountStateV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/me/companion",
      { method: "PATCH", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionAccountStateV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function patchCompanionPersona(t: GatewayTransport, 
    request: CompanionPersonaPatchV1,
    requestId?: string,
  ): Promise<CompanionPersonaMutationV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/pet-profile",
      { method: "PATCH", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionPersonaMutationV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function patchCompanionRoomProfile(t: GatewayTransport, 
    request: CompanionRoomProfilePatchV1,
    requestId?: string,
  ): Promise<CompanionRoomProfileV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/room-profile",
      { method: "PATCH", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionRoomProfileV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function rebuildCompanionMemoryEmbeddings(t: GatewayTransport, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/memory/rebuild-embeddings",
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryQueueResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function recordCompanionVoicePlaybackOutcome(t: GatewayTransport, 
    request: CompanionVoicePlaybackOutcomeRequestV1,
    requestId?: string,
  ): Promise<CompanionVoicePlaybackOutcomeResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/voice/tts/playback-outcome",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionVoicePlaybackOutcomeResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function resetCompanionPersona(t: GatewayTransport, requestId?: string): Promise<CompanionPersonaResetV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/companion/pet-profile/reset",
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionPersonaResetV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function resolveCompanionMemoryConflict(t: GatewayTransport, memoryId: string, removeId: string, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/memory/${safeUuid(memoryId)}/resolve-conflict`,
      { method: "POST", body: JSON.stringify({ removeId: safeUuid(removeId) }) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryConflictResolveResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function searchCompanionHistory(t: GatewayTransport, 
    query: CompanionHistorySearchQueryV1,
    requestId?: string,
  ): Promise<CompanionHistorySearchV1> {
    await t.ensureConnected(requestId);
    const params = new URLSearchParams({ q: query.q });
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const result = await t.request(
      `/companion/history/search?${params.toString()}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionHistorySearchV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function sendCompanionTurn(t: GatewayTransport, 
    request: CompanionChatSendTurnRequestV1,
    requestId?: string,
  ): Promise<CompanionChatSendTurnResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/companion/conversations/${request.conversationId}/turns`,
      { method: "POST", body: JSON.stringify(request.turn), headers: { "Idempotency-Key": request.idempotencyKey } },
      true,
      true,
      requestId,
    );
    const parsed = companionChatSendTurnResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function setAnswerModePreference(t: GatewayTransport, 
    preference: "voice" | "silent" | "text" | "any",
    requestId?: string,
  ) {
    await t.ensureConnected(requestId);
    const result = await t.request("/me/companion/answer-mode-preference", {
      method: "PATCH",
      body: JSON.stringify({ version: 1, preference }),
    }, true, true, requestId);
    const parsed = companionAnswerModePreferenceV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function setCompanionVoicePreference(t: GatewayTransport, 
    input: { engine: TtsEngineV1; voice: string },
    requestId?: string,
  ) {
    await t.ensureConnected(requestId);
    const result = await t.request("/voice/preference", {
      method: "PATCH",
      body: JSON.stringify({ version: 1, ...input }),
    }, true, true, requestId);
    const parsed = companionVoicePreferenceV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function speakCompanionVoice(t: GatewayTransport, 
    request: CompanionVoiceSpeakRequestV1,
    requestId?: string,
  ): Promise<CompanionVoiceSpeakResultV1> {
    await t.ensureConnected(requestId);
    // 只提交纯文本 + 已审核的固定 voice，响应是 raw audio/mpeg。
    const result = await t.requestAudioBytes(
      "/voice/tts",
      {
        method: "POST",
        body: JSON.stringify({ text: request.text, voice: COMPANION_VOICE_SPEAK_VOICE }),
      },
      requestId,
    );
    const parsed = companionVoiceSpeakResultV1Schema.safeParse({
      version: 1,
      mimeType: "audio/mpeg",
      audioBase64: Buffer.from(result.bytes).toString("base64"),
      byteLength: result.bytes.byteLength,
      voice: COMPANION_VOICE_SPEAK_VOICE,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function speakCompanionVoiceSegment(t: GatewayTransport, 
    request: CompanionVoiceSpeakSegmentRequestV2,
    requestId?: string,
  ): Promise<CompanionVoiceSpeakResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.requestAudioBytes(
      "/voice/tts",
      { method: "POST", body: JSON.stringify(request) },
      requestId,
    );
    const parsed = companionVoiceSpeakResultV1Schema.safeParse({
      version: 1,
      mimeType: "audio/mpeg",
      audioBase64: Buffer.from(result.bytes).toString("base64"),
      byteLength: result.bytes.byteLength,
      voice: COMPANION_VOICE_SPEAK_VOICE,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function summarizeRecentCompanionHistory(t: GatewayTransport, requestId?: string) {
    // Renderer 不接触内部 conversation id；main 只在提交 summarizer job 时解析
    // 当前内部分段，然后只回传「已排队」的稳定结果。
    const current = await ensureCompanionConversation(t, { version: 1 }, requestId);
    const result = await t.request(
      `/companion/conversations/${safeUuid(current.conversation.id)}/summarize`,
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryQueueResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function transcribeCompanionVoice(t: GatewayTransport, 
    request: CompanionVoiceTranscribeRequestV1,
    requestId?: string,
  ): Promise<CompanionVoiceTranscribeResultV1> {
    await t.ensureConnected(requestId);
    const configuration = t.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const bytes = Buffer.from(request.audioBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > COMPANION_VOICE_TRANSCRIBE_MAX_AUDIO_BYTES) {
      throw new DesktopGatewayFailure("validation", "user_action");
    }
    const form = new FormData();
    form.set("purpose", "companion_dialogue");
    form.set("language", request.language);
    form.set("durationMs", String(request.durationMs));
    form.set("file", new Blob([bytes], { type: "audio/wav" }), "companion-input.wav");

    const headers = new Headers();
    if (t.token) headers.set("Authorization", `Bearer ${t.token}`);
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) t.activeRequests.set(requestId, controller);
    let response: Response;
    try {
      response = await fetch(new URL("/voice/transcribe", `${configuration.config.apiOrigin}/`), {
        method: "POST",
        headers,
        body: form,
        signal: controller?.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
      }
      t.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    } finally {
      if (requestId && controller && t.activeRequests.get(requestId) === controller) t.activeRequests.delete(requestId);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      t.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok && response.status === 401 && t.tokenIsRestored) {
      await t.discardStoredCredential();
    }
    if (!response.ok) throw t.mapResponseError(response.status, response.headers, undefined, body);
    const parsed = companionVoiceTranscribeResultV1Schema.safeParse(body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function transitionCompanionOnboarding(t: GatewayTransport, 
    version: string,
    request: OnboardingTransitionRequest,
    requestId?: string,
  ): Promise<OnboardingTransitionResponse> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/me/companion/onboarding/${encodeURIComponent(version)}/transition`,
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = onboardingTransitionResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }
