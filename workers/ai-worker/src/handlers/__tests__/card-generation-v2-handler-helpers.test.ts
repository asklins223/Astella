/**
 * 制卡内核里两份纯逻辑的回归（2026-09-15 管线评审 M6/M7 起，2026-09-27 刀二随旧链删余）。
 *
 * - `cardGenerationPromptBlocks`：长笔记全部原文与块序号完整进入生成请求。
 * - `isNonRetryableErrorLike`（`card-generation-v2/retry-classification.ts`）：
 *   "这一发错误能不能重投"的分类，两种形状都要认（下面第三格钉的就是那次事故）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "@astella/shared";

import {
  cardGenerationPromptBlocks,
} from "../../card-generation-v2/run-io.ts";
import { cardGenerationFailureCode, isNonRetryableErrorLike } from "../../card-generation-v2/retry-classification.ts";

test("terminal card failures retain output, timeout and permission causes", () => {
  assert.equal(cardGenerationFailureCode({ failureClass: "output_shape" }), "generation_output_invalid");
  assert.equal(cardGenerationFailureCode({ failureClass: "output_truncated" }), "generation_output_truncated");
  assert.equal(cardGenerationFailureCode({ failureClass: "timeout" }), "generation_timeout");
  assert.equal(cardGenerationFailureCode({ code: "ai_data_policy_denied" }), "ai_data_policy_denied");
  assert.equal(cardGenerationFailureCode(new Error("unrecognized")), "generation_failed");
});

test("长笔记的所有块与末尾完整进入制卡提示，序号保持原样", () => {
  const blocks = Array.from({ length: 3 }, (_, ordinal) => ({ blockId: `block-${ordinal}`, ordinal,
    content: `${"完整材料。".repeat(10_000)}第${ordinal}块末尾` }));
  assert.deepEqual(cardGenerationPromptBlocks(blocks), blocks.map(({ blockId, ordinal, content }) => ({ blockId, ordinal, text: content })));
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
