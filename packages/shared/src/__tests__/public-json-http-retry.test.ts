/**
 * 全局出网重试的判定与执行骨架（2026-10-06）。
 *
 * 用户决定：模型/平台不可用时重试几次后报失败。这里钉住"哪些算可重试、
 * 哪些必须立刻失败"以及重试次数的上界——真实 HTTP 的接线由
 * postJsonToPublicEndpoint / postSseToPublicEndpoint 承担（它们用的是同一个骨架）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  EgressTotalTimeoutError,
  isRetryableEgressStatus,
  isRetryUnsafeError,
  runWithEgressRetry,
  sleepWithSignal,
} from "../public-json-http.ts";
import { CircuitOpenError } from "../circuit-breaker.ts";

test("可重试状态：只认限流与 5xx/网关错，其余 4xx 是请求本身的问题", () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableEgressStatus(status), true, `${status} 应可重试`);
  }
  for (const status of [200, 201, 400, 401, 403, 404, 422, 501]) {
    assert.equal(isRetryableEgressStatus(status), false, `${status} 不该重试`);
  }
});

test("网络抛错重试后成功：尝试次数与退避按约定", async () => {
  const slept: number[] = [];
  let calls = 0;
  const result = await runWithEgressRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("socket hang up");
      return "ok";
    },
    () => false,
    { sleep: async (ms) => { slept.push(ms); } },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(slept, [300, 900], "第二次后应退避 900ms");
});

test("可重试状态耗尽后原样交出最后一次响应，不再问 shouldRetry", async () => {
  let calls = 0;
  let retried = 0;
  const result = await runWithEgressRetry(
    async () => ({ status: 503, body: `err-${++calls}` }),
    (response) => {
      retried += 1;
      return isRetryableEgressStatus(response.status);
    },
    { sleep: async () => {} },
  );
  assert.equal(calls, 3, "总尝试 3 次（含首次）");
  assert.equal(retried, 2, "最后一次不再询问是否重试");
  assert.deepEqual(result, { status: 503, body: "err-3" });
});

test("不可重试状态只发一次", async () => {
  let calls = 0;
  const result = await runWithEgressRetry(
    async () => { calls += 1; return { status: 401, body: null }; },
    (response) => isRetryableEgressStatus(response.status),
    { sleep: async () => {} },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 401);
});

test("调用方 abort 与熔断拒绝、整体超时都不重试", async () => {
  const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  assert.equal(isRetryUnsafeError(abort), true);
  assert.equal(isRetryUnsafeError(new CircuitOpenError("example.com", 5_000)), true);
  assert.equal(isRetryUnsafeError(new EgressTotalTimeoutError("total timeout")), true);
  assert.equal(isRetryUnsafeError(new Error("socket hang up")), false);

  for (const error of [abort, new CircuitOpenError("example.com", 5_000), new EgressTotalTimeoutError("x")]) {
    let calls = 0;
    await assert.rejects(
      () => runWithEgressRetry(async () => { calls += 1; throw error; }, () => true, { sleep: async () => {} }),
      (thrown: unknown) => thrown === error,
    );
    assert.equal(calls, 1, `${(error as Error).name} 不该触发重试`);
  }
});

test("attempts 可调；sleepWithSignal 在 abort 时提前结束等待", async () => {
  let calls = 0;
  await runWithEgressRetry(
    async () => { calls += 1; throw new Error("flaky"); },
    () => false,
    { attempts: 1, sleep: async () => {} },
  ).catch(() => undefined);
  assert.equal(calls, 1, "attempts=1 时只发一次");

  const controller = new AbortController();
  const pending = sleepWithSignal(30_000, controller.signal);
  controller.abort();
  await pending; // 不 abort 的话这里会挂 30s——测的就是它立刻返回。
});
