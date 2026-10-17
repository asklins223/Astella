import assert from "node:assert/strict";
import test from "node:test";
import { resolveClassifierHedgeDelayMs, runHedgedCall } from "../hedged-call.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface TrackedCall {
  readonly call: (signal: AbortSignal) => Promise<string>;
  readonly calls: Array<{
    readonly signal: AbortSignal;
    resolve(value: string): void;
    reject(error: unknown): void;
  }>;
}

/** 每个上游调用都挂在一个可控的 deferred 上，并记录它的取消信号。 */
function trackedCall(): TrackedCall {
  const calls: TrackedCall["calls"][number][] = [];
  return {
    calls,
    call: (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
      // 真实 provider 在上游 abort 时会失败；这里同样让被取消的调用落地，
      // 否则测试里会留下永远不会 settle 的 promise。
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      if (signal.aborted) reject(new Error("aborted"));
    }),
  };
}

test("关闭对冲时只发一条，行为与原来完全一致", async () => {
  const tracked = trackedCall();
  const pending = runHedgedCall(tracked.call, { hedgeDelayMs: -1 });
  await sleep(0);
  assert.equal(tracked.calls.length, 1);
  tracked.calls[0]!.resolve("only");
  const result = await pending;
  assert.deepEqual(result, { value: "only", hedged: false });
});

test("立即对冲：两份同时发出，先到的赢，另一份被取消", async () => {
  const tracked = trackedCall();
  let hedgeNotified = 0;
  const pending = runHedgedCall(tracked.call, { hedgeDelayMs: 0, onHedge: () => { hedgeNotified += 1; } });
  await sleep(0);
  assert.equal(tracked.calls.length, 2, "两份请求都在飞");
  assert.equal(hedgeNotified, 1);
  tracked.calls[1]!.resolve("secondary");
  const result = await pending;
  assert.deepEqual(result, { value: "secondary", hedged: true });
  assert.equal(tracked.calls[0]!.signal.aborted, true, "输掉的主请求被 abort");
});

test("延迟对冲：主请求在触发线内回来就只发一条", async () => {
  const tracked = trackedCall();
  const pending = runHedgedCall(tracked.call, { hedgeDelayMs: 40 });
  await sleep(0);
  tracked.calls[0]!.resolve("fast");
  const result = await pending;
  assert.deepEqual(result, { value: "fast", hedged: false });
  await sleep(60);
  assert.equal(tracked.calls.length, 1, "计时器被清掉，没有再补发副本");
});

test("延迟对冲：主请求越过触发线后才发副本，副本先到则用它", async () => {
  const tracked = trackedCall();
  const pending = runHedgedCall(tracked.call, { hedgeDelayMs: 10 });
  await sleep(20);
  assert.equal(tracked.calls.length, 2, "越过触发线补发了副本");
  tracked.calls[1]!.resolve("secondary");
  const result = await pending;
  assert.deepEqual(result, { value: "secondary", hedged: true });
  assert.equal(tracked.calls[0]!.signal.aborted, true);
});

test("主请求在对冲发出前失败：直接抛原错误，不补发", async () => {
  const tracked = trackedCall();
  const pending = runHedgedCall(tracked.call, { hedgeDelayMs: 50 });
  await sleep(0);
  tracked.calls[0]!.reject(new Error("primary-failed"));
  await assert.rejects(pending, /primary-failed/);
  await sleep(70);
  assert.equal(tracked.calls.length, 1);
});

test("已经并发之后主请求失败：等副本的结果", async () => {
  const tracked = trackedCall();
  const pending = runHedgedCall(tracked.call, { hedgeDelayMs: 0 });
  await sleep(0);
  tracked.calls[0]!.reject(new Error("primary-failed"));
  await sleep(0);
  tracked.calls[1]!.resolve("rescued");
  assert.deepEqual(await pending, { value: "rescued", hedged: true });
});

test("外部取消会同时取消两条上游请求", async () => {
  const controller = new AbortController();
  const tracked = trackedCall();
  const pending = runHedgedCall(tracked.call, { hedgeDelayMs: 0, signal: controller.signal });
  await sleep(0);
  assert.equal(tracked.calls.length, 2);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(tracked.calls[0]!.signal.aborted, true);
  assert.equal(tracked.calls[1]!.signal.aborted, true);
});

test("两条都失败时抛出副本的错误（更近的现场）", async () => {
  const tracked = trackedCall();
  const pending = runHedgedCall(tracked.call, { hedgeDelayMs: 0 });
  await sleep(0);
  tracked.calls[0]!.reject(new Error("primary-failed"));
  tracked.calls[1]!.reject(new Error("secondary-failed"));
  await assert.rejects(pending, /secondary-failed/);
});

test("环境变量：未设置=关闭，on/0=立即并发，正数=延迟，off/负数=关闭", () => {
  assert.equal(resolveClassifierHedgeDelayMs(undefined), -1);
  assert.equal(resolveClassifierHedgeDelayMs(""), -1);
  assert.equal(resolveClassifierHedgeDelayMs("off"), -1);
  assert.equal(resolveClassifierHedgeDelayMs("-5"), -1);
  assert.equal(resolveClassifierHedgeDelayMs("on"), 0);
  assert.equal(resolveClassifierHedgeDelayMs("0"), 0);
  assert.equal(resolveClassifierHedgeDelayMs("750"), 750);
  assert.equal(resolveClassifierHedgeDelayMs("Infinity"), -1);
  assert.equal(resolveClassifierHedgeDelayMs("999999"), 10_000);
});
