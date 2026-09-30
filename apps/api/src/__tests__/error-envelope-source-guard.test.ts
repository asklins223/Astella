import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@ailearn/shared";
import {
  asDomainError,
  buildCompanionErrorBody,
  buildErrorBody,
  buildServiceErrorBody,
  buildSimpleErrorBody,
} from "../lib/error-envelope.ts";

class ServiceError extends DomainError {
  readonly recoveryData?: Record<string, unknown>;
  constructor(code: string, message: string, statusCode: number, recoveryData?: Record<string, unknown>) {
    super({ name: "ServiceError", code, message, statusCode });
    this.recoveryData = recoveryData;
  }
}

class PlainError extends DomainError {
  constructor(code: string, message: string, statusCode: number) {
    super({ name: "PlainError", code, message, statusCode });
  }
}

test("只认 DomainError 及其子类，其它错误一律不认", () => {
  const domain = new ServiceError("a", "m", 400);
  assert.equal(asDomainError(domain), domain);
  const plain = new PlainError("b", "m", 400);
  assert.equal(asDomainError(plain), plain);
  // 这些都**不是**领域错误，交给 setErrorHandler：它们自带 statusCode 但语义不同
  assert.equal(asDomainError(new Error("boom")), null);
  assert.equal(asDomainError({ code: "x", statusCode: 400 }), null);
  assert.equal(asDomainError("string error"), null);
  assert.equal(asDomainError(undefined), null);
});

test("A 线：recoveryData 展开在顶层，且没有它时不多出字段", () => {
  const withData = new ServiceError("stale_run_revision", "运行状态已变化", 409, {
    currentRevision: 7,
    expected: 5,
  });
  assert.deepEqual(buildServiceErrorBody(withData), {
    error: "stale_run_revision",
    message: "运行状态已变化",
    currentRevision: 7,
    expected: 5,
  });
  const without = new ServiceError("x", "m", 400);
  assert.deepEqual(buildServiceErrorBody(without), { error: "x", message: "m" });
});

test("recoveryData 为 null / 非对象时不落进 body（不能产出 recoveryData: null）", () => {
  const weird = new ServiceError("x", "m", 400, undefined);
  assert.deepEqual(Object.keys(buildServiceErrorBody(weird)).sort(), ["error", "message"]);
  // 显式塞一个非对象
  const bad = new ServiceError("x", "m", 400, "not-an-object" as unknown as Record<string, unknown>);
  assert.deepEqual(buildServiceErrorBody(bad), { error: "x", message: "m" });
});

test("B 线：不带 recoveryData，即使错误对象上有那个字段", () => {
  const err = new ServiceError("x", "m", 400, { secret: 1 });
  assert.deepEqual(buildSimpleErrorBody(err), { error: "x", message: "m" });
});

test("C 线：带 version/recoverable/requestId，且 5xx 脱敏", () => {
  const client = new PlainError("note_not_found", "这篇笔记现在读不到", 404);
  assert.deepEqual(
    buildCompanionErrorBody(client, { recoverable: false, requestId: "req-1" }),
    { version: 1, error: "note_not_found", message: "这篇笔记现在读不到", recoverable: false, requestId: "req-1" },
  );

  // 5xx 必须脱敏：内部 message 可能含连接串 / 上游报错原文
  const server = new PlainError("internal", "connect ECONNREFUSED 10.0.0.5:5432", 500);
  const body = buildCompanionErrorBody(server, { recoverable: true, requestId: "req-2" });
  assert.equal(body.message, "服务器内部错误");
  assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|10\.0\.0\.5/);
  assert.equal(body.recoverable, true);
});

test("A / B 线默认**不**脱敏（保持收口前的行为），显式要求才脱敏", () => {
  const server = new PlainError("internal", "connect ECONNREFUSED", 500);
  assert.equal(buildServiceErrorBody(server).message, "connect ECONNREFUSED");
  assert.equal(buildServiceErrorBody(server, { maskServerErrors: true }).message, "服务器内部错误");
  // 4xx 即使开了脱敏也不该被换掉——4xx 的 message 是给用户看的
  const client = new PlainError("bad", "参数不对", 400);
  assert.equal(buildServiceErrorBody(client, { maskServerErrors: true }).message, "参数不对");
});

test("可自定义 5xx 占位文案", () => {
  const server = new PlainError("internal", "boom", 503);
  assert.equal(
    buildServiceErrorBody(server, { maskServerErrors: true, serverErrorMessage: "稍后再试" }).message,
    "稍后再试",
  );
});

test("buildErrorBody 的 extra 字段按「有才写」处理", () => {
  const err = new PlainError("x", "m", 400);
  assert.deepEqual(buildErrorBody(err, {}), { error: "x", message: "m" });
  assert.deepEqual(buildErrorBody(err, { version: 1 }), { version: 1, error: "x", message: "m" });
  // 显式给 undefined 的字段不出现
  assert.ok(!("requestId" in buildErrorBody(err, { requestId: undefined })));
});

test("C 线的 5xx 判定用的是 statusCode，不是 500 精确相等", () => {
  const err = new PlainError("x", "内部细节", 503);
  assert.equal(buildCompanionErrorBody(err, { recoverable: true, requestId: "r" }).message, "服务器内部错误");
});

/**
 * 守卫：错误信封只能在 `lib/error-envelope.ts` 里手写。
 *
 * 收口前 `reply.code(err.statusCode).send({ error: err.code, message: … })`
 * 这一句在 5 个文件里有 32 份变体。变体多本身不致命，致命的是**它们会漂**：
 * 有的脱敏 5xx、有的不脱敏；有的带 `recoverable`、有的不带。
 * 客户端看到的行为就不一致，而没有任何测试会为此变红。
 *
 * 判据刻意只拦这一种**手写形状**，不拦所有 `reply.code(...).send(`——
 * 很多 4xx 是正常业务响应（`{ error: "not_found", message: "资源不存在" }`），
 * 那些不是错误信封。
 */
test("路由层不再手写 { error: <x>.code, message: <x>.message } 这种错误信封", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join, relative } = await import("node:path");
  // 退两级才是 apps/api/ 包根（".." 只拿到 src/，下面 join("src") 会变成 src/src）
  const API_ROOT = new URL("../..", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(full);
    }
  };
  walk(join(API_ROOT, "src"));

  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(API_ROOT, file).split("/").join("/");
    if (rel === "src/lib/error-envelope.ts") continue;
    const src = readFileSync(file, "utf8");
    const pattern = /\.code\([^)]*\.statusCode\)\s*\.send\(\s*\{\s*error:\s*\w+\.code\s*,\s*message:/;
    if (pattern.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "又手写了错误信封——走 lib/error-envelope.ts 的 build* 函数：\n" + offenders.join("\n"));
});
