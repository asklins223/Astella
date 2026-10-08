/** Keep crash-recovery leases alive independently of the task's execution deadline. */
export async function runWithLeaseHeartbeat<T>(options: {
  signal: AbortSignal;
  intervalMs: number;
  renew: (signal: AbortSignal) => Promise<void>;
  operation: (signal: AbortSignal) => Promise<T>;
  onLateError?: (error: unknown) => void;
}): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let renewalController: AbortController | undefined;
  let stopped = false;
  let rejectStop!: (error: unknown) => void;
  const stop = new Promise<never>((_, reject) => { rejectStop = reject; });
  // A failed initial renewal can precede the operation/race subscription.
  void stop.catch(() => {});
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    controller.abort(error);
    rejectStop(error);
  };
  const onAbort = () => fail(options.signal.reason ?? new DOMException("Job cancelled", "AbortError"));
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await renew();
        schedule();
      } catch (error) { fail(error); }
    }, options.intervalMs);
  };
  const renew = () => {
    renewalController = new AbortController();
    return options.renew(AbortSignal.any([controller.signal, renewalController.signal]));
  };
  let task: Promise<T> | undefined;
  let taskSettled = false;
  try {
    await Promise.race([renew(), stop]);
    controller.signal.throwIfAborted();
    schedule();
    task = Promise.resolve().then(() => options.operation(controller.signal)).finally(() => { taskSettled = true; });
    return await Promise.race([task, stop]);
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    renewalController?.abort(new DOMException("Job execution ended", "AbortError"));
    options.signal.removeEventListener("abort", onAbort);
    if (!taskSettled) void task?.catch(error => options.onLateError?.(error));
  }
}
