export class HandlerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`job timed out after ${timeoutMs}ms`);
    this.name = "HandlerTimeoutError";
  }
}

/** Node timers have a signed 32-bit delay; longer policies need re-arming,
 * otherwise Node turns a healthy long task into a one-millisecond timeout. */
function scheduleDeadline(timeoutMs: number, expire: () => void): () => void {
  if (!Number.isFinite(timeoutMs)) return () => undefined;
  const deadlineAt = Date.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) { expire(); return; }
    timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
  };
  tick();
  return () => { if (timer) clearTimeout(timer); };
}

/**
 * Abort the operation when its deadline expires. The operation may still take
 * time to unwind, so callers must also fence persistent side effects with the
 * job lease associated with the same signal.
 */
export async function runWithAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onLateError?: (error: unknown) => void,
): Promise<T> {
  const controller = new AbortController();
  const task = Promise.resolve().then(() => operation(controller.signal));
  let cancelDeadline: (() => void) | undefined;
  let timedOut = false;

  const deadline = new Promise<never>((_, reject) => {
    cancelDeadline = scheduleDeadline(timeoutMs, () => {
      timedOut = true;
      const error = new HandlerTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    });
  });

  try {
    return await Promise.race([task, deadline]);
  } finally {
    cancelDeadline?.();
    if (timedOut) {
      void task.catch((error) => onLateError?.(error));
    }
  }
}

/**
 * Give one nested operation a smaller budget than its parent handler.
 *
 * The child receives its own AbortSignal. A child timeout never aborts the
 * parent signal, leaving the handler enough time to persist a deterministic
 * fallback or a retryable state. Parent cancellation still propagates down.
 */
export async function runWithAbortBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  onLateError?: (error: unknown) => void,
): Promise<T> {
  const controller = new AbortController();
  let cancelDeadline: (() => void) | undefined;
  let settledByDeadline = false;
  let rejectDeadline: ((reason: unknown) => void) | undefined;

  const task = Promise.resolve().then(() => operation(controller.signal));
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
    cancelDeadline = scheduleDeadline(timeoutMs, () => {
      settledByDeadline = true;
      const error = new HandlerTimeoutError(timeoutMs);
      reject(error);
      controller.abort(error);
    });
  });

  const onParentAbort = () => {
    settledByDeadline = true;
    const reason = parentSignal?.reason instanceof Error
      ? parentSignal.reason
      : new DOMException("parent operation aborted", "AbortError");
    rejectDeadline?.(reason);
    controller.abort(reason);
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  try {
    return await Promise.race([task, deadline]);
  } finally {
    cancelDeadline?.();
    parentSignal?.removeEventListener("abort", onParentAbort);
    if (settledByDeadline) {
      void task.catch((error) => onLateError?.(error));
    }
  }
}
