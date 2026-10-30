import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../../lib/logger.ts";
import { isNonRetryableError } from "../../lib/non-retryable-errors.ts";
import { ProviderRequestError, ProviderStreamError } from "../../lib/provider-request-error.ts";
import { CompanionStreamStoppedError } from "../turn/companion-dialogue-stream.ts";
import { CompanionOutputTimeoutError } from "./companion-output-watchdog.ts";

/**
 * 瞬时传输故障的重试边界。
 *
 * 只重试“同样一发请求再发一次有意义”的失败：网关 408/429/5xx、流在首字前
 * 断掉、空流、以及还没有任何可见输出的首字超时。鉴权/欠费/参数错误/输出合同
 * 错误不重试；已经下发过文字的步骤由流式那边的 `stepEmitted` 判据负责。
 * 每次重试都受整轮 deadline 与取消信号约束。
 */
export function isTransientCompanionModelError(error: unknown): boolean {
  // No first token means no user-visible output yet: a fresh attempt cannot
  // duplicate text. An idle timeout after output is different and is not retried.
  if (error instanceof CompanionOutputTimeoutError)
    return error.code !== "provider_idle_timeout";
  if (error instanceof CompanionStreamStoppedError || isNonRetryableError(error)) return false;
  if (error instanceof ProviderRequestError) return error.status === 408 || error.status === 429 || error.status >= 500;
  if (error instanceof ProviderStreamError) {
    return ["stream_empty", "stream_incomplete", "stream_failed"].includes(error.code);
  }
  return false;
}

export async function runWithCompanionModelRetries<T>(
  run: () => Promise<T>,
  input: {
    signal: AbortSignal; deadlineAt: number; attempts?: number;
    /**
     * 这一轮还有另一档 provider 可换（`fallbackProvider`）。
     *
     * 首字超时说明**这一档**没接上：换一档比把同一档再问两遍更可能真的拿到输出，
     * 所以那时不在这里重试，让上层切到兜底档。没有可换的档才按瞬时故障重试。
     */
    switchProviderAvailable?: boolean;
  },
): Promise<T> {
  const attempts = input.attempts ?? 3;
  const retryable = (error: unknown): boolean =>
    isTransientCompanionModelError(error)
    && !(input.switchProviderAvailable === true
      && error instanceof CompanionOutputTimeoutError && error.code !== "provider_idle_timeout");
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || input.signal.aborted || Date.now() >= input.deadlineAt
        || !retryable(error)) throw error;
      logger.warn({ err: error, attempt }, "companion model step hit a transient transport error; retrying");
      await delay(Math.min(1_000, 250 * 2 ** (attempt - 1)), undefined, { signal: input.signal });
    }
  }
}
