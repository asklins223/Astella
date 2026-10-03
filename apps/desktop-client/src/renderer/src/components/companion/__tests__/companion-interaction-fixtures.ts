import { vi } from "vitest";
import type { CompanionChatSession, CompanionProposalUiState } from "../../../app/companion-chat-session";
import type { CompanionHudSettings } from "../CompanionHud";

export function interactionSession(overrides: Partial<CompanionChatSession> = {}): CompanionChatSession {
  return {
    phase: "ready", failure: null, conversationId: "44444444-4444-4444-8444-444444444444",
    messages: [], liveReply: null, richReply: null, draft: null, interrupted: null, nodes: [], runTraces: [],
    feedSelection: null, feedPrompt: null, feedNoteAnchor: null, feedNoteIntent: null,
    autoSendRequestId: null, navChips: [], proposalStates: {}, mode: "conversation", companionName: "小鲸",
    historyHasMore: false, historyLoadingOlder: false, historyOlderError: null, historyRevision: 0,
    assistantCue: null, cancelling: false, stopNotice: null,
    setCompanionName: vi.fn(), loadOlderMessages: vi.fn(async () => undefined), fetchAllMessages: vi.fn(async () => []),
    send: vi.fn(async () => true), cancel: vi.fn(async () => true), dismissStopNotice: vi.fn(),
    dismissLiveReply: vi.fn(), dismissRichReply: vi.fn(), dismissFeedSelection: vi.fn(),
    dismissFeedNoteAnchor: vi.fn(), dismissFeedNoteIntent: vi.fn(), setMode: vi.fn(), dismissNavChip: vi.fn(),
    decideProposal: vi.fn(async () => undefined), retryProposal: vi.fn(), goToRoute: vi.fn(async () => undefined), ...overrides,
  } as CompanionChatSession;
}

export function interactionSettings(): CompanionHudSettings {
  return {
    scale: 1, scaleMin: .7, scaleMax: 1.3, pageMuted: false, taskActive: false, focusUntilTaskEnd: false,
    onScale: vi.fn(), onTogglePageMuted: vi.fn(), onToggleFocus: vi.fn(),
    onHide: vi.fn(), onResetPosition: vi.fn(),
  };
}

export function interactionProposal(status: "pending" | "succeeded" = "pending", expiresAt: string | null = null): CompanionProposalUiState {
  return { phase: "ready", proposal: {
    status, expiresAt, title: "收下这张学习卡", targetSummary: "当前笔记", impactSummary: "新增一张学习卡",
  } } as CompanionProposalUiState;
}
