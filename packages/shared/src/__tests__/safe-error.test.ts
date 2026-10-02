import assert from "node:assert/strict";
import { test } from "node:test";
import {
  safeErrorMessage,
  safeErrorSerializer,
  sanitizeOperationalError,
} from "../safe-error.ts";

/**
 * 在指定 NODE_ENV 下执行，并**原样恢复**。
 *
 * 为什么必须钉住而不是依赖运行环境：脱敏门控读的是 `process.env.NODE_ENV`，
 * 而本文件同时断言「生产不泄漏」与「开发会给诊断」——不钉住的话，
 * 开发机 / CI 上跑出来的结论会随环境漂移。
 */
function withNodeEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

test("operational errors redact SQL, parameters, stacks, and user content", () => {
  const secret = "用户答案：光合作用会产生氧气";
  const error = Object.assign(
    new Error(`Failed query: insert into learning_assessments params: ${secret}`),
    {
      name: "DrizzleQueryError",
      code: "23505",
      cause: new Error(`provider response contained ${secret}`),
    },
  );
  error.stack = `Error: ${secret}\n at secret-handler.ts:10:2`;

  // 显式钉 production：下面「不泄漏」的断言必须在任何调用方式下都成立。
  withNodeEnv("production", () => {
    const projected = sanitizeOperationalError(error);
    const persisted = safeErrorMessage(error);
    const logged = JSON.stringify(safeErrorSerializer(error));

    assert.deepEqual(projected, {
      category: "database",
      name: "DrizzleQueryError",
      code: "23505",
    });
    assert.equal(persisted, "operational_error:database:DrizzleQueryError:23505");
    for (const output of [persisted, logged]) {
      assert.ok(!output.includes(secret));
      assert.ok(!output.includes("insert into"));
      assert.ok(!output.includes("params"));
      assert.ok(!output.includes("secret-handler"));
    }
  });
});

test("safe error messages are idempotent", () => {
  const message = "operational_error:timeout:HandlerTimeoutError";
  assert.equal(safeErrorMessage(message), message);
  assert.deepEqual(sanitizeOperationalError(message), {
    category: "timeout",
    name: "HandlerTimeoutError",
    code: null,
  });
});

test("unsafe names and codes are bounded instead of copied", () => {
  const error = {
    name: "Error\nsecret payload",
    message: "invalid provider output with private content",
    code: "BAD CODE: private",
  };
  assert.deepEqual(sanitizeOperationalError(error), {
    category: "validation",
    name: "Error",
    code: null,
  });
});

test("serializer is byte-identical to the sanitized projection outside development", () => {
  const error = Object.assign(new Error("boom"), { name: "RangeError", code: null });
  // 逐个环境钉：production、test、**以及未设置**。
  // 未设置这一档最要紧——它是「预发环境忘配 NODE_ENV」的现实形状，
  // 门控必须在那儿依然保持脱敏（这正是用 === "development" 而非 !== 的原因）。
  for (const env of ["production", "test", "staging", undefined]) {
    withNodeEnv(env, () => {
      const serialized = safeErrorSerializer(error);
      assert.deepEqual(serialized, sanitizeOperationalError(error), `NODE_ENV=${String(env)}`);
      assert.ok(!("diag" in serialized), `NODE_ENV=${String(env)} 不应带 diag`);
      // 键集合也必须一致，而不只是深相等——多一个 diag: undefined 同样是泄漏面。
      assert.deepEqual(Object.keys(serialized).sort(), ["category", "code", "name"]);
    });
  }
});

test("serializer appends bounded dev diagnostics only in development", () => {
  const error = Object.assign(
    new Error("Maximum call stack size exceeded"),
    { name: "RangeError", cause: new Error("root cause") },
  );
  error.stack = "RangeError: Maximum call stack size exceeded\n    at scopeOfSession (client.ts:130:3)";

  withNodeEnv("development", () => {
    const serialized = safeErrorSerializer(error);
    assert.equal(serialized.category, "unknown");
    assert.equal(serialized.name, "RangeError");
    assert.equal(serialized.diag?.message, "Maximum call stack size exceeded");
    // 堆栈必须能定位到函数与行号——这正是当初查不出来的那条信息。
    assert.ok(serialized.diag?.stack.includes("at scopeOfSession (client.ts:130:3)"));
    assert.ok(serialized.diag?.stack.includes("Caused by: Error: root cause"));
  });
});

test("dev diagnostics are bounded so one pathological error cannot flood the log", () => {
  const error = new Error("x".repeat(5_000));
  error.stack = "y".repeat(20_000);
  withNodeEnv("development", () => {
    const diag = safeErrorSerializer(error).diag;
    assert.ok(diag);
    assert.ok(diag.message.length <= 512, `message 长度 ${diag.message.length} 越界`);
    assert.ok(diag.stack.length <= 4_096, `stack 长度 ${diag.stack.length} 越界`);
  });
});

test("persistence projection never carries dev diagnostics even in development", () => {
  const error = new Error("insert into notes params: 用户答案");
  withNodeEnv("development", () => {
    // 持久化路径与日志路径是**两件事**：开发期诊断只走后者。
    assert.ok(!("diag" in sanitizeOperationalError(error)));
    const persisted = safeErrorMessage(error);
    assert.ok(!persisted.includes("用户答案"));
    assert.ok(!persisted.includes("insert into"));
  });
});
