import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { logger } from "../lib/logger.ts";
import { AgentOutputError, CompanionAgentBudgetExceededError, CompanionKnowledgeReviewError } from "../lib/non-retryable-errors.ts";
import { emitCompanionAssistantStatus } from "./companion-dialogue-store.ts";
import { buildCompanionKnowledgeReview, parseCompanionKnowledgeReview } from "./companion-knowledge-review.ts";
import { finishStep } from "./companion-agent-events.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";

/** Review buffered explanations before publication. The caller retains the
 * provider task and compaction ownership; review failures settle its step. */
export async function reviewCompanionExplanation(options: {
  event: AgentEventContext;
  stepId: string;
  request: AgentTurnRequest;
  draft: string;
  stepCount: number;
  deadlineAt: number;
  updateRequest: (request: AgentTurnRequest) => void;
  execute: (request: AgentTurnRequest, timeoutMs: number) => Promise<AgentTurnResult>;
}): Promise<AgentTurnResult> {
  const { event: turn, request, draft, stepCount, stepId, deadlineAt } = options;
  try {
    const revision = buildCompanionKnowledgeReview(request, draft, {
      voiceExpressionEnabled: !turn.read.groundedTutorContext && turn.read.petProfile?.boundaries?.allowVoiceTags !== false,
    });
    options.updateRequest(revision);
    const reviewTimeout = Math.min(resolveProviderCallTimeout("companion_agent"), deadlineAt - Date.now());
    if (reviewTimeout <= 0) {
      throw new CompanionAgentBudgetExceededError("companion explanation review deadline exceeded");
    }
    await emitCompanionAssistantStatus({
      workspaceId: turn.ctx.workspaceId, read: turn.read, expiresAt: turn.expiresAt,
      status: "thinking", safeLabel: "正在核对解释…",
    });
    logger.info({ runId: turn.read.runId, stepCount }, "companion explanation review started before publication");
    const reviewed = await options.execute(revision, reviewTimeout);
    // Preserve finishReason, usage and checkpoint identity. Private JSON never
    // enters the visible stream decoder.
    if (reviewed.finishReason === "length") {
      throw new AgentOutputError("output_truncated", "companion knowledge review reached its output ceiling");
    }
    if (reviewed.finishReason !== "stop" || reviewed.toolCalls.length > 0) {
      throw new CompanionKnowledgeReviewError();
    }
    const report = parseCompanionKnowledgeReview(reviewed.content ?? "", draft);
    logger.info({ runId: turn.read.runId, stepCount, corrections: report.corrections.length,
      issueKinds: [...new Set(report.corrections.map(c => c.issue))] },
      "companion explanation review completed; answer awaits publication guards");
    return { ...reviewed, content: report.answer };
  } catch (error) {
    const deadlineExceeded = Date.now() >= deadlineAt || turn.ctx.signal.aborted;
    await finishStep(turn, stepId, "failed", undefined,
      deadlineExceeded ? "AGENT_DEADLINE_EXCEEDED"
        : error instanceof CompanionKnowledgeReviewError ? error.code
          : error instanceof AgentOutputError ? "AGENT_BUDGET_EXCEEDED" : "PROVIDER_UNAVAILABLE");
    throw error;
  }
}
