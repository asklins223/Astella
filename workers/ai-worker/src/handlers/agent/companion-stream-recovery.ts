import type { AgentTurnResult } from "@astella/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { logger } from "../../lib/logger.ts";
import { ProviderRequestError } from "../../lib/provider-request-error.ts";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";
import { CompanionOutputTimeoutError } from "./companion-output-watchdog.ts";
import { CompanionDegenerateLoopError } from "./companion-agent-streaming-step.ts";
import { companionStreamRepeatsItself } from "../turn/companion-reply-shape.ts";

/**
 * What to do after a streaming attempt failed before delivering anything.
 *
 * Every branch here produces a result or rethrows; none of them decides what the
 * user reads. Keeping the ladder in one place means the loop in
 * `companion-agent-runtime.ts` only wires the transports together.
 */
export async function recoverCompanionStreamFailure(input: {
  error: unknown;
  /** Retry the same step on the current provider, buffered. */
  runBuffered: (attempts?: number) => Promise<AgentTurnResult>;
  /** Re-run the streaming attempt once (used for transient 5xx). */
  attemptStream: () => Promise<AgentTurnResult>;
  canRetryStream: (error: unknown) => boolean;
  stepProvider: AIProvider;
  fallbackProvider: AIProvider | null | undefined;
  fitsFallback: () => Promise<boolean>;
  /** Adopt the fallback provider and mark the turn as having switched. */
  useFallback: (provider: AIProvider) => void;
  stepCount: number;
  runId: string;
}): Promise<AgentTurnResult> {
  const { error, stepCount, runId } = input;

  if (error instanceof CompanionDegenerateLoopError) {
    // The model looped instead of finishing. Retry this step on the configured
    // alternate; nothing after the first repeat is new content, so the looped
    // text is dropped.
    logger.warn({ runId, stepCount, chars: error.text.length },
      "companion reply degraded into a repetition loop; retrying the step");
    if (input.fallbackProvider && input.fallbackProvider !== input.stepProvider
      && await input.fitsFallback()) input.useFallback(input.fallbackProvider);
    const retried = await input.runBuffered(1);
    if (companionStreamRepeatsItself(String(retried.content ?? "")))
      throw new AgentOutputError("no_progress", "companion reply repeated itself on the retry");
    return retried;
  }

  if (!input.canRetryStream(error)) throw error;
  // Pass the error object, not its message: the serializer projects anything
  // else down to `{name:"Error"}`, erasing whether this was a 504 or "the body
  // is not SSE".
  logger.warn({ err: error, stepCount }, "companion streaming answer failed before any delta");

  // A first-output timeout means this route produced nothing, not that the
  // request is bad. If another configured model can fit it, use that instead of
  // repeating the same empty wait. One attempt: the fallback is recovery, not a
  // second retry stack.
  const firstOutputTimeout = error instanceof CompanionOutputTimeoutError
    && error.code !== "provider_idle_timeout";
  if (firstOutputTimeout && input.fallbackProvider && input.fallbackProvider !== input.stepProvider
    && typeof input.fallbackProvider.executeAgentTurn === "function" && await input.fitsFallback()) {
    logger.warn({ runId, stepCount, fallbackModelId: input.fallbackProvider.modelId },
      "companion first-output timeout switched to a fitting fallback model");
    input.useFallback(input.fallbackProvider);
    return typeof input.fallbackProvider.chatCompletionStream === "function" ? input.attemptStream() : input.runBuffered(1);
  }
  if (firstOutputTimeout) {
    // No usable alternate route: retry once, not the default three-attempt
    // stack. A stalled route must not hold the turn for several empty waits.
    return input.attemptStream();
  }
  if (error instanceof ProviderRequestError && error.status >= 500) {
    // A 5xx before any delta is transient: retry the stream once, then fall
    // back to the buffered turn. Nothing was delivered, so no duplicate prefix.
    try {
      return await input.attemptStream();
    } catch (retryError) {
      if (!input.canRetryStream(retryError)) throw retryError;
      if (input.fallbackProvider && input.fallbackProvider !== input.stepProvider
        && typeof input.fallbackProvider.chatCompletionStream === "function" && await input.fitsFallback()) {
        input.useFallback(input.fallbackProvider);
        return input.attemptStream();
      }
      logger.warn({ err: retryError, stepCount },
        "companion streaming retry failed before any delta; using the last buffered attempt");
      return input.runBuffered(1);
    }
  }
  logger.warn({ stepCount },
    "companion streaming answer failed for a non-transient reason; retrying with buffered turn");
  return input.runBuffered();
}
