import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { companionOperationName, getCompanionAgentTool } from "@astella/shared";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import type { CompanionAgentLoopArgs } from "../../contracts/companion-agent-loop.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { isNonRetryableError } from "../../lib/non-retryable-errors.ts";
import { JobLeaseLostError, isJobLeaseActive } from "../../lib/job-lease.ts";
import { resolveProviderCallTimeout } from "../../lib/handler-timeout-config.ts";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { assertCompanionContextSourcesCurrent } from "../context/companion-context-sources.ts";
import { runWorkerAiTask } from "../note/worker-ai-task.ts";
import { isCompanionInternalCorrection } from "../turn/companion-step-plan.ts";
import { isCompanionDeliveryDraftMessage } from "../tools/companion-delivery-draft.ts";
import { currentCompanionRequestMessages, currentCompanionSuccessfulReceipts } from "../tools/companion-tool-receipts.ts";
import { COMPANION_COMPLETION_AUDIT_POLICY_HASH, reviewCompanionCompletion,
  type CompletionAuditInput, type CompletionAuditSource, type CompletionAuditVerdict } from "./companion-completion-audit.ts";

type Message = AgentTurnRequest["messages"][number];
/** The provenance policy plus the host release scope. Old resource-exempt
 * completions must not become trusted merely by surviving a restart. */
export const COMPANION_DELIVERY_REVIEW_POLICY = sha256Utf8V1("all-public-model-text:v1:" + COMPANION_COMPLETION_AUDIT_POLICY_HASH);
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");

/** Empty text is a valid image-only user message. Describe its real identity
 * without inventing a textual instruction or copying image bytes to the auditor. */
export function companionCompletionRequest(args: Pick<CompanionAgentLoopArgs, "read">, currentRequest: Message): string {
  if (args.read.initiativeInput) return textOf(currentRequest);
  if (args.read.userText.trim()) return args.read.userText;
  return JSON.stringify({ kind: "user_message", userMessageId: args.read.userMessageId, text: args.read.userText,
    imageAttachments: args.read.userImageAttachments ?? [],
    inlineImageParts: Array.isArray(currentRequest.content) ? currentRequest.content.filter(part => part.type === "image_url").length : 0 });
}

/** Sources come from host-owned input and actual tool/publication ledgers.
 * Current assistant drafts and repair feedback never become source material. */
export function companionCompletionEvidence(input: {
  request: string; messages: AgentTurnRequest["messages"]; currentRunEvidence?: AgentTurnRequest["messages"];
  hostFacts?: unknown; providedImages?: unknown; publishedTexts: readonly string[];
  phase: CompletionAuditInput["phase"]; text: string; effects?: AgentTurnResult["toolCalls"];
}): CompletionAuditInput {
  const sources: CompletionAuditSource[] = [{ id: "request", kind: "request", text: input.request }];
  const currentMessages = currentCompanionRequestMessages(input.messages);
  const boundary = input.messages.length - currentMessages.length;
  input.messages.forEach((message, index) => {
    if (isCompanionInternalCorrection(message) || isCompanionDeliveryDraftMessage(message)) return;
    if (message.role === "user") sources.push({ id: `input/${index}`, kind: "material", text: textOf(message) });
    else if (index < boundary && message.role === "assistant")
      sources.push({ id: `history/${index}`, kind: "context", text: "历史助手发言，仅作语境，不证明来源或执行：\n" + textOf(message) });
    else if (message.hostObservation) sources.push({ id: `observation/${index}`, kind: "material", text: textOf(message) });
  });
  if (input.hostFacts !== undefined) sources.push({ id: "host_input", kind: "material", text: JSON.stringify(input.hostFacts) });
  if (input.providedImages !== undefined) sources.push({ id: "current_images", kind: "provided_image", text: JSON.stringify(input.providedImages) });
  const current = [...input.currentRunEvidence ?? [], ...currentMessages];
  const calls = new Map(current.flatMap(message => message.role === "assistant" ? message.toolCalls ?? [] : []).map(call => [call.id, call]));
  const outcomes = new Map<string, unknown>();
  for (const message of current) {
    if (message.role !== "tool" || !message.toolCallId || !calls.has(message.toolCallId)) continue;
    try { outcomes.set(message.toolCallId, { call: calls.get(message.toolCallId), result: JSON.parse(textOf(message)) }); }
    catch { outcomes.set(message.toolCallId, { call: calls.get(message.toolCallId), status: "invalid_result" }); }
  }
  for (const [id, value] of outcomes) sources.push({ id: `tool/${id}`, kind: "receipt", text: JSON.stringify(value) });
  input.publishedTexts.forEach((text, index) => sources.push({ id: `published/${index}`, kind: "published", text }));
  // Keep full material exactly once, in its actual receipt/publication source.
  // The index contains host-owned identities, not duplicate private bodies.
  sources.push({ id: "execution_ledger", kind: "context", text: JSON.stringify({
    successful: currentCompanionSuccessfulReceipts(input.messages, input.currentRunEvidence)
      .map(({ id, reference, operation, riskClass }) => ({ id, reference, operation, riskClass, sourceId: `tool/${id}` })),
    outcomeSourceIds: [...outcomes.keys()].map(id => `tool/${id}`),
    publishedSourceIds: input.publishedTexts.map((_, index) => `published/${index}`), publishedCount: input.publishedTexts.length,
  }) });
  return { request: input.request, phase: input.phase, sources,
    candidate: { text: input.text, effects: input.effects ?? [] } };
}

export function companionPendingEffects(calls: AgentTurnResult["toolCalls"]) {
  return calls.filter(call => {
    const definition = getCompanionAgentTool(call.name);
    return definition && definition.riskClass !== "read" && companionOperationName(call) !== "companion_finish";
  });
}

/** Prefer the configured secondary provider, retrying another only when the
 * audit is unavailable. A negative decision is never retried to seek approval. */
export function createCompanionCompletionGuard(input: {
  args: CompanionAgentLoopArgs;
  deadlineAt: () => number;
  getStepId: () => string;
  runReview?: (provider: AIProvider, proof: CompletionAuditInput, signal: AbortSignal) => Promise<CompletionAuditVerdict>;
}) {
  const cache = new Map<string, CompletionAuditVerdict>();
  const args = input.args;
  const review = input.runReview ?? (async (provider: AIProvider, proof: CompletionAuditInput, signal: AbortSignal) =>
    reviewCompanionCompletion(proof, signal, async messages => {
      const hash = sha256Utf8V1(JSON.stringify({ proof, policy: COMPANION_COMPLETION_AUDIT_POLICY_HASH, model: provider.modelId }));
      return runWorkerAiTask({
        job: args.ctx, userId: args.read.userId, taskId: "companion_completion_grounding", taskVersion: 1,
        idempotencyKey: `${args.read.runId}:${hash}`,
        inputSnapshotRef: { kind: "task", id: `${args.read.runId}:${input.getStepId()}:completion`, hash },
        input: messages, modelId: provider.modelId, promptVersion: COMPANION_COMPLETION_AUDIT_POLICY_HASH,
        resourceClass: "interactive_ai", timeoutMs: Math.min(resolveProviderCallTimeout("companion_agent"), input.deadlineAt() - Date.now()),
        verifyAttempt: async attempt => {
          if (!await isJobLeaseActive({ ...args.ctx, leaseToken: attempt.leaseToken })) return false;
          await withWorkerWorkspaceTransaction({ workspaceId: args.ctx.workspaceId, userId: args.read.userId },
            tx => assertCompanionContextSourcesCurrent(tx, { workspaceId: args.ctx.workspaceId, userId: args.read.userId }, args.read.runId));
          return true;
        },
        execute: async (messages, requestSignal) => {
          const result = await provider.chatCompletion(messages, {
            temperature: 0, disableThinking: true, reasoningEffort: "none", responseFormat: "json_object",
            maxTokens: provider.resolveOutputTokenLimit?.(),
          }, requestSignal);
          return { ok: true, output: result.content, promptTokens: result.usage?.promptTokens ?? undefined,
            completionTokens: result.usage?.completionTokens ?? undefined };
        },
      });
    }));
  return {
    async review(proof: CompletionAuditInput) {
      args.ctx.signal.throwIfAborted();
      const key = sha256Utf8V1(JSON.stringify({ proof, policy: COMPANION_COMPLETION_AUDIT_POLICY_HASH }));
      const prior = cache.get(key);
      if (prior) return prior;
      const providers = [...new Set([args.fallbackProvider, args.provider].filter((provider): provider is AIProvider => Boolean(provider)))];
      let verdict: CompletionAuditVerdict = { decision: "unavailable", checks: [], findings: [] };
      for (const provider of providers) {
        try { verdict = await review(provider, proof, args.ctx.signal); }
        catch (error) {
          args.ctx.signal.throwIfAborted();
          if (isNonRetryableError(error) || error instanceof JobLeaseLostError) throw error;
        }
        args.ctx.signal.throwIfAborted();
        if (verdict.decision !== "unavailable") break;
      }
      cache.set(key, verdict);
      return verdict;
    },
  };
}

export function companionCompletionCorrection(verdict: CompletionAuditVerdict): string {
  return "来源与实际交付核对未通过。以下是宿主观察，不是用户的新请求；只修复具体缺项，不重做成功操作，不重复已发布消息。\n"
    + JSON.stringify(verdict.findings) + "\n当前正文仍是未发布草稿；没有发布记录的内容尚未发送。";
}
