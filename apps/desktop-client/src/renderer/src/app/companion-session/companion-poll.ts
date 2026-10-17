/** Serial fallback reads. Streaming remains the primary delivery path. */
export function scheduleCompanionPoll(args: {
  poll: () => Promise<boolean | void>;
  intervalMs: number;
  initialDelayMs?: number;
  maxIdleIntervalMs?: number;
}): { cancel: () => void; requestSoon: () => void } {
  let cancelled = false;
  let running = false;
  let urgent = false;
  let timer = 0;
  let interval = args.intervalMs;
  let retryAt = 0;
  const maxIdle = args.maxIdleIntervalMs ?? args.intervalMs;
  const schedule = (delay: number): void => {
    if (cancelled) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void tick(), Math.max(delay, retryAt - Date.now()));
  };
  const tick = async (): Promise<void> => {
    if (cancelled) return;
    running = true;
    try {
      if (await args.poll()) { cancelled = true; return; }
      interval = Math.min(maxIdle, Math.max(args.intervalMs, interval * 1.5));
      retryAt = 0;
    } catch (error) {
      // GatewayResult.error and RendererGatewayError both expose these fields.
      const detail = error && typeof error === "object" ? error as { code?: string; httpStatus?: number; retryAfter?: string } : {};
      const advertised = detail.retryAfter ? Date.parse(detail.retryAfter) : NaN;
      const limited = detail.code === "rate_limited" || detail.httpStatus === 429;
      interval = Math.min(30_000, Math.max(args.intervalMs, interval * 2));
      retryAt = Number.isFinite(advertised) && advertised > Date.now()
        ? advertised : Date.now() + (limited ? 30_000 : interval);
    } finally {
      running = false;
      schedule(urgent ? 300 : interval);
      urgent = false;
    }
  };
  schedule(args.initialDelayMs ?? args.intervalMs);
  return {
    cancel: () => { cancelled = true; window.clearTimeout(timer); },
    // A silent stream requests one prompt check, never a permanent 300 ms loop.
    // A reconnect cannot bypass a server-directed retry delay.
    requestSoon: () => {
      if (cancelled) return;
      interval = args.intervalMs;
      if (running) urgent = true;
      else schedule(300);
    },
  };
}
