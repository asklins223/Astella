/**
 * Whether a fallback provider can actually take this request.
 *
 * The fallback slot may declare a small context window (the DeepSeek slot is
 * 64k while the primary is far larger). Steering a step onto it when it cannot
 * fit turns a recoverable steering attempt into a whole-turn
 * AGENT_BUDGET_EXCEEDED, so the caller stays on the primary instead.
 */

import { measureAgentTurnRequest, resolveContextBudget } from "@astella/agent-core";
import type { AgentTurnRequest } from "@astella/shared";

export interface CompanionProviderCapability {
  visionModelId?: string;
  getCapabilities?: () => {
    visionModelId?: string;
    contextWindowTokens?: number;
    outputLimitEnforced?: boolean;
  } | null;
  resolveOutputTokenLimit?: () => number | null | undefined;
}

export async function companionProviderFitsRequest(
  provider: CompanionProviderCapability,
  request: AgentTurnRequest,
): Promise<boolean> {
  const capability = provider.getCapabilities?.();
  const hasPixels = request.messages.some(message => Array.isArray(message.content)
    && message.content.some(part => part.type === "image_url"));
  // A window that fits does not make a text-only model able to see. Some
  // transports silently discard images for such models, producing plausible
  // answers without pixels. Unknown vision is not a usable image fallback.
  if (hasPixels && !(capability?.visionModelId ?? provider.visionModelId)?.trim()) return false;
  if (!capability || !Number.isSafeInteger(capability.contextWindowTokens)
    || (capability.contextWindowTokens ?? 0) <= 0) {
    return true; // Unknown window: keep the previous behaviour rather than refuse.
  }
  try {
    const measured = await measureAgentTurnRequest(request);
    const budget = resolveContextBudget({
      capability: capability as Parameters<typeof resolveContextBudget>[0]["capability"],
      requestedOutputTokens: provider.resolveOutputTokenLimit?.() ?? request.maxTokens ?? null,
      outputLimitEnforced: capability.outputLimitEnforced,
    });
    return measured.inputTokens <= budget.hardInputTokens;
  } catch {
    return true;
  }
}
