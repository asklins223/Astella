import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isTransientCompanionModelError, runWithCompanionModelRetries } from "../agent/companion-model-retries.ts";
import { CompanionOutputTimeoutError } from "../agent/companion-output-watchdog.ts";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";

test("首字前超时可重试，输出后的失活与输出合同错误不重试", () => {
  assert.equal(isTransientCompanionModelError(new CompanionOutputTimeoutError("provider_first_output_timeout")), true);
  assert.equal(isTransientCompanionModelError(new CompanionOutputTimeoutError("provider_idle_timeout")), false);
  assert.equal(isTransientCompanionModelError(new AgentOutputError("no_progress", "repeat")), false);
  assert.equal(isTransientCompanionModelError(new Error("plain")), false);
});

test("首字超时换一次采样后成功，不把一次波动打成失败", async () => {
  let attempts = 0;
  const value = await runWithCompanionModelRetries(async () => {
    attempts += 1;
    if (attempts === 1) throw new CompanionOutputTimeoutError("provider_first_output_timeout");
    return "ok";
  }, { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 });
  assert.equal(value, "ok");
  assert.equal(attempts, 2);
});

test("已经取消或超过整轮 deadline 时不再重试", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  await assert.rejects(runWithCompanionModelRetries(async () => {
    attempts += 1;
    throw new CompanionOutputTimeoutError("provider_first_output_timeout");
  }, { signal: controller.signal, deadlineAt: Date.now() + 5_000 }));
  assert.equal(attempts, 1);

  let expiredAttempts = 0;
  await assert.rejects(runWithCompanionModelRetries(async () => {
    expiredAttempts += 1;
    throw new CompanionOutputTimeoutError("provider_first_output_timeout");
  }, { signal: new AbortController().signal, deadlineAt: Date.now() - 1 }));
  assert.equal(expiredAttempts, 1);
});

test("等待重试之间可被取消", async () => {
  const controller = new AbortController();
  let called = false;
  const running = runWithCompanionModelRetries(async () => {
    called = true;
    throw new CompanionOutputTimeoutError("provider_first_output_timeout");
  }, { signal: controller.signal, deadlineAt: Date.now() + 5_000, attempts: 3 });
  while (!called) await delay(0);
  controller.abort();
  await assert.rejects(running);
});
