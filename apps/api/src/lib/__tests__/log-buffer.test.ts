/**
 * 日志环形缓冲的契约测试。
 *
 * 两条性质各值一条用例：
 *   1. **pino 的契约不能破**——钩子必须调用传入的 `method`，否则那条日志
 *      就真的丢了。为省事不调用它是这类钩子最经典的写法错误。
 *   2. **它是有界窗口**——容量满了之后旧条目被挤掉，而不是无限增长。
 *      一个把内存吃光的"日志查看器"比没有更糟。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { LogRingBuffer, createLogCaptureHook } from "../log-buffer.ts";

/**
 * 触发钩子。
 *
 * pino 把 logMethod 的 `this` 声明成 `Logger`，而测试里根本没有 logger 实例。
 * 这里做一次显式收窄：钩子体只用到 `this` 转发给 method，两者都不是它自己读的属性。
 */
function fire(
  hook: ReturnType<typeof createLogCaptureHook>,
  args: unknown[],
  method: () => void,
  level: number,
): void {
  (hook as unknown as (this: unknown, ...rest: unknown[]) => void).call({}, args, method, level);
}


test("环形缓冲：新 → 旧，且不超过容量", () => {
  const buffer = new LogRingBuffer(3);
  buffer.push(30, "第一条", {});
  buffer.push(30, "第二条", {});
  buffer.push(30, "第三条", {});
  buffer.push(30, "第四条", {});

  assert.equal(buffer.size, 3);
  const entries = buffer.recent();
  assert.deepEqual(entries.map((e) => e.msg), ["第四条", "第三条", "第二条"]);
  assert.equal(entries[0].seq, 4, "序号单调递增，可作稳定排序键");
});

test("环形缓冲：回绕之后仍然按新 → 旧排序", () => {
  const buffer = new LogRingBuffer(2);
  buffer.push(30, "a", {});
  buffer.push(30, "b", {});
  buffer.push(30, "c", {});
  buffer.push(30, "d", {});
  assert.deepEqual(buffer.recent().map((e) => e.msg), ["d", "c"]);
});

test("级别过滤：minLevel 按名字生效", () => {
  const buffer = new LogRingBuffer(10);
  buffer.push(20, "调试", {});
  buffer.push(30, "信息", {});
  buffer.push(40, "警告", {});
  buffer.push(50, "错误", {});

  assert.equal(buffer.recent({ minLevel: "warn" }).length, 2);
  assert.deepEqual(buffer.recent({ minLevel: "error" }).map((e) => e.msg), ["错误"]);
  assert.equal(buffer.recent({ minLevel: "trace" }).length, 4);
  // silent 是 pino 的最高级别：以它为下限时没有任何条目能通过。
  assert.equal(buffer.recent({ minLevel: "silent" }).length, 0);
  // 完全未知的名字退回最宽松，而不是静默返回空。
  assert.equal(buffer.recent({ minLevel: "nope" as never }).length, 4);
});

test("limit 有上界，且至少为 1", () => {
  const buffer = new LogRingBuffer(10);
  for (let i = 0; i < 10; i += 1) buffer.push(30, `m${i}`, {});
  assert.equal(buffer.recent({ limit: 3 }).length, 3);
  assert.equal(buffer.recent({ limit: 0 }).length, 1, "0 应被抬到 1");
  assert.equal(buffer.recent({ limit: 100_000 }).length, 10);
});

test("字段压缩：超长字符串截断带标记，对象/数组只留形状", () => {
  const buffer = new LogRingBuffer(4);
  buffer.push(30, "长字段", {
    big: "x".repeat(5_000),
    obj: { nested: true },
    arr: [1, 2, 3],
    n: 42,
    b: false,
    when: new Date("2026-01-02T03:04:05.000Z"),
  });
  const entry = buffer.recent()[0];
  assert.ok(String(entry.fields.big).includes("…(+"), "截断必须留下「还有多少」的标记");
  assert.ok(String(entry.fields.big).length < 2_000);
  assert.deepEqual(entry.fields.obj, { __type: "object" });
  assert.deepEqual(entry.fields.arr, { __type: "array", length: 3 });
  assert.equal(entry.fields.n, 42);
  assert.equal(entry.fields.b, false);
  assert.equal(entry.fields.when, "2026-01-02T03:04:05.000Z");
});

test("字段数量有上限，防止一条日志挤掉整个窗口", () => {
  const buffer = new LogRingBuffer(2);
  const fields = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
  buffer.push(30, "宽日志", fields);
  assert.ok(Object.keys(buffer.recent()[0].fields).length <= 24);
});

test("pino 钩子：调用 method（日志必须真的写出去）且把内容送进缓冲", () => {
  const buffer = new LogRingBuffer(10);
  const hook = createLogCaptureHook(buffer);

  let invoked = false;
  const method = () => {
    invoked = true;
  };

  fire(hook, ["hello", { scope: "test", runId: "r1" }], method, 30);

  assert.equal(invoked, true, "钩子不调用 method 就会静默吞掉这条日志");
  const entry = buffer.recent()[0];
  assert.equal(entry.msg, "hello");
  assert.equal(entry.level, "info");
  assert.equal(entry.fields.scope, "test");
  assert.equal(entry.fields.runId, "r1");
});

test("pino 钩子：纯对象写法（无独立 msg）不把整个对象塞进 msg", () => {
  const buffer = new LogRingBuffer(10);
  const hook = createLogCaptureHook(buffer);
  fire(hook, [{ event: "job_done", id: 7 }], () => {}, 40);
  const entry = buffer.recent()[0];
  assert.equal(entry.msg, "(no message)");
  assert.equal(entry.fields.event, "job_done");
  assert.equal(entry.fields.id, 7);
});

test("pino 钩子：log(obj, msg) 形态——消息在第二个位置（Fastify 请求日志就是这种）", () => {
  const buffer = new LogRingBuffer(10);
  const hook = createLogCaptureHook(buffer);
  // 只看第一个参数会把这条整条记成 "(no message)"，缓冲里只剩一堆空壳。
  fire(hook, [{ req: { id: 7 } }, "request completed"], () => {}, 30);
  const entry = buffer.recent()[0];
  assert.equal(entry.msg, "request completed");
  assert.deepEqual(entry.fields.req, { __type: "object" });
});

test("pino 钩子：msg 内嵌在对象里时优先用内嵌的那个", () => {
  const buffer = new LogRingBuffer(10);
  const hook = createLogCaptureHook(buffer);
  fire(hook, [{ msg: "内嵌", extra: 1 }], () => {}, 30);
  const entry = buffer.recent()[0];
  assert.equal(entry.msg, "内嵌");
  assert.equal(entry.fields.extra, 1);
  assert.equal("msg" in entry.fields, false, "msg 不应同时出现在字段里");
});

test("pino 钩子：尾部合并字段与前置对象合并到一起", () => {
  const buffer = new LogRingBuffer(10);
  const hook = createLogCaptureHook(buffer);
  fire(hook, [{ a: 1 }, "消息", { b: 2 }], () => {}, 30);
  const entry = buffer.recent()[0];
  assert.equal(entry.msg, "消息");
  assert.equal(entry.fields.a, 1);
  assert.equal(entry.fields.b, 2);
});

test("pino 钩子：即使捕获抛错也仍然调用 method（日志落地优先）", () => {
  // 用一个会在 push 时抛错的替身来模拟缓冲故障。
  const broken = {
    push() {
      throw new Error("模拟缓冲写失败");
    },
  };
  const hook = createLogCaptureHook(broken as unknown as LogRingBuffer);
  let invoked = false;
  fire(hook, ["仍然要写出去"], () => {
    invoked = true;
  }, 50);
  assert.equal(invoked, true, "捕获失败绝不能影响日志落地");
});