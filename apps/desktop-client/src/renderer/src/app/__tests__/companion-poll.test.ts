// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { scheduleCompanionPoll } from "../companion-poll";

afterEach(() => { vi.useRealTimers(); });

it("a silent SSE requests one prompt read, then returns to low-frequency polling", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => false);
  const poll = scheduleCompanionPoll({ poll: read, intervalMs: 3_000, maxIdleIntervalMs: 5_000 });
  await vi.advanceTimersByTimeAsync(10_000);
  const before = read.mock.calls.length;
  poll.requestSoon();
  await vi.advanceTimersByTimeAsync(300);
  expect(read).toHaveBeenCalledTimes(before + 1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read.mock.calls.length).toBeLessThanOrEqual(28);
  poll.cancel();
});

it("Retry-After is respected even when the stream asks for a prompt read", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValueOnce({ code: "rate_limited", retryAfter: new Date(Date.now() + 60_000).toISOString() })
    .mockResolvedValue(true);
  const poll = scheduleCompanionPoll({ poll: read, intervalMs: 3_000, initialDelayMs: 0 });
  await vi.advanceTimersByTimeAsync(0);
  poll.requestSoon();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(2);
});

it("slow reads never overlap and cancellation prevents a late read from restarting the timer", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const read = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const poll = scheduleCompanionPoll({ poll: read, intervalMs: 3_000, initialDelayMs: 0 });
  await vi.advanceTimersByTimeAsync(60_000);
  poll.requestSoon();
  expect(read).toHaveBeenCalledTimes(1);
  poll.cancel();
  finish();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(1);
});
