import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker, CircuitOpenError } from "../circuit-breaker.ts";

/** 手动推进的时钟：熔断的时间行为必须在测试里可复现，不能靠真等。 */
function fakeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function breakerWith(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  const clock = fakeClock();
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 1_000,
    now: clock.now,
    ...overrides,
  });
  return { breaker, clock };
}

const ok = (status = 200) => async () => ({ status });

test("闭合状态下连续失败到阈值才打开，前几次照常放行", () => {
  const { breaker } = breakerWith();
  assert.doesNotThrow(() => breaker.assertCanAttempt("api.example.com"));
  breaker.recordFailure("api.example.com");
  assert.doesNotThrow(() => breaker.assertCanAttempt("api.example.com"));
  breaker.recordFailure("api.example.com");
  assert.doesNotThrow(() => breaker.assertCanAttempt("api.example.com"));
  assert.equal(breaker.peek("api.example.com"), "closed");
  breaker.recordFailure("api.example.com");
  assert.equal(breaker.peek("api.example.com"), "open");
  assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
});

test("open 时抛的错说明还要等多久，且明确没有发出网络请求", () => {
  const { breaker, clock } = breakerWith();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
  clock.advance(400);
  try {
    breaker.assertCanAttempt("api.example.com");
    assert.fail("熔断打开时必须抛");
  } catch (error) {
    assert.ok(error instanceof CircuitOpenError);
    assert.equal(error.circuitHost, "api.example.com");
    assert.equal(error.retryAfterMs, 600);
    assert.match(error.message, /没有发出网络请求/);
  }
});

test("冷却期满进 half-open，且只放一个探测", () => {
  const { breaker, clock } = breakerWith();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
  clock.advance(1_000);
  // 第一个探测放行
  breaker.assertCanAttempt("api.example.com");
  assert.equal(breaker.peek("api.example.com"), "half-open");
  // 第二个必须挡掉——放多个等于没有熔断
  assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
});

test("half-open 探测成功 → 关闭并清零；失败 → 立刻回 open 且冷却重新计时", () => {
  const { breaker, clock } = breakerWith();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
  clock.advance(1_000);
  breaker.assertCanAttempt("api.example.com");
  breaker.recordSuccess("api.example.com");
  assert.equal(breaker.peek("api.example.com"), "closed");
  assert.doesNotThrow(() => breaker.assertCanAttempt("api.example.com"));

  // 重新攒够失败 → open → 冷却 → 探测失败
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
  clock.advance(1_000);
  breaker.assertCanAttempt("api.example.com");
  breaker.recordFailure("api.example.com");
  assert.equal(breaker.peek("api.example.com"), "open");
  // 冷却是**重新**计时的：刚走完 1s 冷却立刻又 open，再等 1s 才放探测
  assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
  clock.advance(1_000);
  assert.doesNotThrow(() => breaker.assertCanAttempt("api.example.com"));
});

test("按 host 分键：一个上游熔掉不连坐同进程其它上游", () => {
  const { breaker } = breakerWith();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("a.example.com");
  assert.equal(breaker.peek("a.example.com"), "open");
  assert.equal(breaker.peek("b.example.com"), "closed");
  assert.doesNotThrow(() => breaker.assertCanAttempt("b.example.com"));
});

test("5xx 与 429 计入失败；普通 4xx 不计（参数错不该熔掉整条线路）", async () => {
  const { breaker } = breakerWith();
  // 400 连打 5 次也不开
  for (let i = 0; i < 5; i += 1) await breaker.run("x.example.com", ok(400));
  assert.equal(breaker.peek("x.example.com"), "closed");

  // 429 算
  const b2 = breakerWith().breaker;
  for (let i = 0; i < 3; i += 1) await b2.run("y.example.com", ok(429));
  assert.equal(b2.peek("y.example.com"), "open");

  // 503 算
  const b3 = breakerWith().breaker;
  for (let i = 0; i < 3; i += 1) await b3.run("z.example.com", ok(503));
  assert.equal(b3.peek("z.example.com"), "open");
});

test("一次成功会清零连续失败计数（不是滑动窗口）", async () => {
  const { breaker } = breakerWith();
  await breaker.run("api.example.com", ok(200));
  breaker.recordFailure("api.example.com");
  breaker.recordFailure("api.example.com");
  await breaker.run("api.example.com", ok(200));
  breaker.recordFailure("api.example.com");
  breaker.recordFailure("api.example.com");
  assert.equal(breaker.peek("api.example.com"), "closed");
});

test("attempt 抛出的异常计入失败，且原样抛出（不吞不改类型）", async () => {
  const { breaker } = breakerWith();
  const boom = new TypeError("connect ECONNREFUSED");
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(
      () => breaker.run("api.example.com", async () => {
        throw boom;
      }),
      (err: unknown) => err === boom,
    );
  }
  assert.equal(breaker.peek("api.example.com"), "open");
  await assert.rejects(() => breaker.run("api.example.com", ok(200)), CircuitOpenError);
});

test("熔断打开时 attempt 一次都不执行（连 attempt 本身都不调）", async () => {
  const { breaker } = breakerWith();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
  let called = 0;
  await assert.rejects(
    () => breaker.run("api.example.com", async () => {
      called += 1;
      return { status: 200 };
    }),
    CircuitOpenError,
  );
  assert.equal(called, 0);
});

test("reset 能清掉某个 host，也能全清", () => {
  const { breaker } = breakerWith();
  breaker.recordFailure("a.example.com");
  breaker.reset("a.example.com");
  assert.equal(breaker.peek("a.example.com"), "closed");
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("b.example.com");
  breaker.reset();
  assert.equal(breaker.peek("b.example.com"), "closed");
});

test("拒绝观察者只在真的挡住请求时触发，并区分 open / half_open", () => {
  const seen: Array<{ host: string; reason: string }> = [];
  const { breaker, clock } = breakerWith();
  const off = breaker.setRejectObserver((host, reason) => {
    seen.push({ host, reason });
  });
  try {
    // 闭合时正常放行 —— 一次都不该记
    breaker.assertCanAttempt("api.example.com");
    assert.equal(seen.length, 0);

    for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
    assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
    assert.deepEqual(seen, [{ host: "api.example.com", reason: "open" }]);

    // 冷却未满：继续记 open
    clock.advance(100);
    assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.reason, "open");

    // 冷却期满：第一个探测**放行**，不记；第二个撞上 half_open，记 half_open
    clock.advance(1_000);
    assert.doesNotThrow(() => breaker.assertCanAttempt("api.example.com"));
    assert.equal(seen.length, 2);
    assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.reason, "half_open");
  } finally {
    off();
  }
});

test("拒绝观察者异常不影响熔断，并留下可读健康状态", () => {
  const { breaker, clock } = breakerWith();
  breaker.setRejectObserver(() => {
    throw new Error("metrics registry is on fire");
  });
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
  // 该抛的仍然是 CircuitOpenError，而不是埋点那个错
  assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
  assert.deepEqual(breaker.rejectObserverHealth(), {
    installed: true,
    healthy: false,
    failuresTotal: 1,
    consecutiveFailures: 1,
    lastFailureAt: 1_000,
  });

  breaker.setRejectObserver(() => undefined);
  assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
  assert.deepEqual(breaker.rejectObserverHealth(), {
    installed: true,
    healthy: true,
    failuresTotal: 1,
    consecutiveFailures: 0,
    lastFailureAt: 1_000,
  });
  clock.advance(10);
  assert.equal(breaker.rejectObserverHealth().lastFailureAt, 1_000);
});

test("摘掉观察者后不再触发", () => {
  const { breaker } = breakerWith();
  let count = 0;
  const off = breaker.setRejectObserver(() => {
    count += 1;
  });
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
  assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
  assert.equal(count, 1);
  off();
  breaker.reset();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("api.example.com");
  assert.throws(() => breaker.assertCanAttempt("api.example.com"), CircuitOpenError);
  assert.equal(count, 1);
});
