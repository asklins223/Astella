import { createHash } from "node:crypto";
import { COMPANION_HOST_PROTOCOL_V8, COMPANION_IDENTITY_BOUNDARY_V4, type AgentTurnRequest } from "@astella/shared";
import { COMPANION_VOICE_EXPRESSION_PROTOCOL_V1 } from "@astella/shared/voice-expression-tags";
import type { AgentContextReceipt } from "@astella/agent-core";
import { buildCompanionPersonaMessages } from "../handlers/companion-dialogue-content.ts";
import { buildCasualFirstStepRequest } from "../handlers/companion-speculative-first-step.ts";
import { companionStepRuntimePolicy } from "../handlers/companion-step-plan.ts";
import { companionResponseStrategy } from "../handlers/companion-response-strategy.ts";
import { companionTurnThinking } from "../handlers/companion-turn-thinking.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";
import { renderCompanionConversationEvidence } from "../handlers/companion-conversation-evidence.ts";
import type { DialogueGenerationFixture } from "./dialogue-cases.ts";

export type DialogueContextCondition = "full" | "relevant";
// Domain content hashes intentionally allow safe integers only. Provider
// requests contain fractional temperatures, so hash their stable JSON instead.
export const hashDialogueValue = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite request number");
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
  })).digest("hex");

/** Source material is synthetic and shared across conditions, never a target answer. */
const backgroundSources = {
  hereAndNow: "当前在合成测试学习空间，页面为笔记库。当前消息发送时间及读取时钟另见 conversation_timeline。",
  conversationSummary: "更早的合成会话中，用户聊过整理学习资料。此摘要不表示当前用户仍在请求整理。",
  pageContext: { pageType: "notebook_library", activeNoteId: null },
};

export function buildDialogueExperimentRequest(fixture: DialogueGenerationFixture,
  condition: DialogueContextCondition, maxTokens: number,
  personaExamples: "current" | "absent" = "current") {
  const receipts: AgentContextReceipt[] = [];
  const persona = resolveCompanionPersonaContext(null);
  const petProfile = personaExamples === "absent" ? { ...persona, examples: [] } : persona;
  const messages = buildCompanionPersonaMessages({
    userText: fixture.userText, recentMessages: fixture.history, petProfile,
    pageContext: condition === "full" ? backgroundSources.pageContext : null,
    hereAndNow: condition === "full" ? backgroundSources.hereAndNow : null,
    conversationSummary: condition === "full" ? backgroundSources.conversationSummary : null,
    conversationClock: { observedAt: "2026-10-07T08:30:00.000Z", timezone: "Asia/Shanghai",
      currentMessageCreatedAt: "2026-10-07T08:30:00.000Z" },
    contextReceipt: r => receipts.push(...r),
  });
  const attention = { intent: fixture.intent, toolUse: "none" } as const;
  const strategy = companionResponseStrategy(attention);
  const turnPolicy = String(messages[0]!.content);
  const request = buildCasualFirstStepRequest({ turnPolicy, permissionLevel: "read_only", stepBudget: 3,
    messages: messages.slice(1) as AgentTurnRequest["messages"], maxTokens });
  if (fixture.intent !== "conversation") {
    request.systemPrompt = [turnPolicy, companionStepRuntimePolicy({ permissionLevel: "read_only", toolCount: 0,
      stepBudget: 3, finalAnswerOnly: false, attentionIntent: fixture.intent }), strategy.guidance].filter(Boolean).join("\n");
    request.temperature = strategy.temperature;
    request.disableThinking = companionTurnThinking(attention).disableThinking;
  }
  return { request, receipts, provenance: {
    synthetic: true, builder: fixture.intent === "conversation" ? "buildCasualFirstStepRequest" : "pre-resolved knowledge request",
    interpretation: attention, originalHistoryHash: hashDialogueValue(fixture.history),
    generationFixtureHash: hashDialogueValue(fixture), personaExamples,
    removedSources: condition === "relevant" ? ["here_and_now", "summary", "page_context"] : [],
    note: "Controlled expression diagnostic using production builders; synthetic unrelated background and fixed interpretation. Not a captured HTTP/database turn or a proof that production has these irrelevant sources.",
  } };
}

/** Multi-change capability diagnostic, deliberately unavailable to production. */
export function buildDialogueIdentityDiagnostic(fixture: DialogueGenerationFixture, maxTokens: number) {
  const control = buildDialogueExperimentRequest(fixture, "relevant", maxTokens, "absent");
  const identity = "你是用户书房里的 AI 伴星，名字叫伴星。你说简体中文，语气松弛，有自己的观察和一点干巴巴的幽默。你和用户可以聊日常，也可以认真讨论问题；回应眼前的话，性格体现在具体的看法和用词里。";
  const timeline = renderCompanionConversationEvidence(fixture.history, {
    observedAt: "2026-10-07T08:30:00.000Z", timezone: "Asia/Shanghai", currentMessageCreatedAt: "2026-10-07T08:30:00.000Z",
  });
  const turnPolicy = [COMPANION_HOST_PROTOCOL_V8, COMPANION_IDENTITY_BOUNDARY_V4, identity,
    timeline, COMPANION_VOICE_EXPRESSION_PROTOCOL_V1].filter(Boolean).join("\n\n");
  const execution = companionStepRuntimePolicy({ permissionLevel: "read_only", toolCount: 0,
    stepBudget: 3, finalAnswerOnly: false, attentionIntent: fixture.intent });
  const strategy = companionResponseStrategy({ intent: fixture.intent, toolUse: "none" });
  return { request: { ...control.request, systemPrompt: [turnPolicy, execution,
    fixture.intent === "conversation" ? null : strategy.guidance].filter(Boolean).join("\n\n") }, provenance: {
    ...control.provenance, builder: "diagnostic-only concise identity", personaExamples: "absent",
    changedPolicySources: ["character_base", "account_persona", "data_preamble", "conversation_evidence"],
    retainedPolicySources: ["host_protocol", "identity_boundary", "voice_expression", "conversation_timeline", "execution"],
    note: "Multiple prompt changes with unchanged native messages, parameters and mandatory host/identity/permission/output contracts. Capability diagnostic only; cannot isolate a single cause or become a production default.",
  } };
}

/** Keep only replayable text/tool request data, never hidden reasoning handles. */
export function snapshotDialogueRequest(request: AgentTurnRequest) {
  if (request.messages.some(message => message.reasoning?.length))
    throw new Error("Dialogue snapshots cannot retain reasoning replay handles");
  const value = structuredClone(request);
  return { version: 1 as const, hash: hashDialogueValue(value), request: value };
}

/** Whitelist the actual provider payload; callers may use it only with synthetic inputs. */
export function snapshotDialogueWireBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid wire body");
  const original = body as Record<string, unknown>;
  const keys = ["model", "instructions", "input", "messages", "tools", "tool_choice", "temperature",
    "max_output_tokens", "max_tokens", "reasoning", "reasoning_effort", "enable_thinking", "thinking", "stream", "text", "response_format"];
  const payload = Object.fromEntries(keys.filter(key => key in original).map(key => [key, original[key]]));
  // Reasoning configuration is retained; generated replay items are not.
  if (Array.isArray(payload.input) && payload.input.some(item => item?.type === "reasoning"))
    throw new Error("Dialogue wire snapshots cannot retain reasoning replay items");
  if (Array.isArray(payload.messages) && payload.messages.some(item => item?.reasoning_content || item?.reasoning))
    throw new Error("Dialogue wire snapshots cannot retain generated reasoning");
  const value = structuredClone(payload);
  const omittedFieldCount = Object.keys(original).filter(key => !keys.includes(key)).length;
  return { version: 1 as const, hash: hashDialogueValue(value), body: value,
    complete: omittedFieldCount === 0, omittedFieldCount };
}

export function dialogueMatrixSchedule(ids: readonly string[], repeats: number) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 2 || new Set(ids).size !== ids.length || !ids.length)
    throw new Error("Invalid matrix selection");
  const conditions = ["current/full", "current/relevant", "candidate/full", "candidate/relevant"] as const;
  return ids.flatMap((caseId, caseIndex) => Array.from({ length: repeats }, (_, repeat) => {
    const offset = (caseIndex + repeat * 2) % conditions.length;
    return [...conditions.slice(offset), ...conditions.slice(0, offset)].map(condition => ({ caseId, repeat, condition }));
  }).flat());
}
