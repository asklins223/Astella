/**
 * 制卡内核里两份纯逻辑的回归（2026-09-15 管线评审 M6/M7 起，2026-09-27 刀二随旧链删余）。
 *
 * - `capSourceContentForPrompts`（`card-generation-v2/run-io.ts`）：源文本规模硬上限。
 *   旧链的四阶段 prompt 与简化链的 block 列表输入都受它管（后者是刀二补的那一格）。
 * - `isNonRetryableErrorLike`（`card-generation-v2/retry-classification.ts`）：
 *   "这一发错误能不能重投"的分类，两种形状都要认（下面第三格钉的就是那次事故）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DomainError } from "@astella/shared";

import {
  capSourceContentForPrompts,
  V2_SOURCE_CONTENT_MAX_CHARS,
} from "../../card-generation-v2/run-io.ts";
import { isNonRetryableErrorLike } from "../../card-generation-v2/retry-classification.ts";

test("源文本上限：未超限原样返回；超限截断并标记", () => {
  const workspaceId = randomUUID();
  const small = "x".repeat(10);
  assert.deepEqual(capSourceContentForPrompts(small, workspaceId), {
    content: small,
    truncated: false,
    originalLength: small.length,
  });

  const huge = "y".repeat(V2_SOURCE_CONTENT_MAX_CHARS + 5_000);
  const capped = capSourceContentForPrompts(huge, workspaceId);
  assert.equal(capped.truncated, true);
  assert.equal(capped.content.length, V2_SOURCE_CONTENT_MAX_CHARS);
  assert.ok(huge.startsWith(capped.content));
});

// ─── 2026-09-17 事故回归：非重试错误被当成可重试 ────────────────────────────
//
// 事故形态：`providers.ts` 的 mock/未配置 provider fail-closed 抛的是**裸 Error**，
// 只设置 `name="CardGenerationProviderError"` + `retryable=false`，没有 `kind` 字段；
// 而 `isNonRetryableErrorLike` 只读 `kind` → 判成可重试 → outbox 按
// 15/30/60/120/240s 退避重试 6 次（dev 库实测 7m45s 墙钟）、期间零 LLM 调用，
// 用户只看到长时间"生成中"然后 needs_attention。
//
// 契约：**两种错误形状都必须被尊重**——任何一个"显式标注不可重试"的错误都不得
// 进入重试退避。

test("错误分类：裸 Error 只带 retryable=false（2026-09-17 事故形态）判为不可重试", () => {
  const err = new Error(
    "card-generation-v2 LLM mode resolved to mock provider: missing API key or platform not configured",
  ) as Error & { retryable: boolean };
  err.name = "CardGenerationProviderError";
  err.retryable = false;
  assert.equal(isNonRetryableErrorLike(err), true);
});

test("错误分类：同类裸 Error 标记 retryable=true 时仍按可重试处理", () => {
  const err = new Error("provider transient failure") as Error & { retryable: boolean };
  err.name = "CardGenerationProviderError";
  err.retryable = true;
  assert.equal(isNonRetryableErrorLike(err), false);
});

test("错误分类：CardGenerationProviderError 类实例按 kind 判定（canonical 形状）", async () => {
  const { CardGenerationProviderError } = await import("../../card-generation-v2/governed-provider.ts");
  assert.equal(
    isNonRetryableErrorLike(new CardGenerationProviderError("non-retryable", "config error")),
    true,
  );
  assert.equal(
    isNonRetryableErrorLike(new CardGenerationProviderError("retryable", "HTTP 503")),
    false,
  );
});

test("错误分类：未标注的普通错误保持可重试（不误伤瞬态故障）", () => {
  assert.equal(isNonRetryableErrorLike(new Error("socket hang up")), false);
  assert.equal(isNonRetryableErrorLike("ECONNRESET"), false);
});

test("错误分类：明确的 4xx 领域拒绝不可重试，5xx 领域错误保留重试", () => {
  assert.equal(isNonRetryableErrorLike(new DomainError({
    name: "AIConsentRequiredError", code: "ai_consent_required", message: "consent required", statusCode: 403,
  })), true);
  assert.equal(isNonRetryableErrorLike(new DomainError({
    name: "UpstreamUnavailableError", code: "upstream_unavailable", message: "try again", statusCode: 503,
  })), false);
});
