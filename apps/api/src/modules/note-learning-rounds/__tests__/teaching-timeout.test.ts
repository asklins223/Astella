/**
 * 讲解那一发允许多久，由"这一轮还剩多少墙钟"决定，不是由某篇短笔记的实测耗时决定。
 *
 * 实测（2026-10-14）：一篇 37 万字符的长笔记上 `POST /v2/note-learning-rounds/:id/teaching`
 * 在 **110.1 秒**整回 503 `teaching_failed`——那是过去写死的 55 s/步 + 110 s/任务两道闸
 * （110 s = 一发被切 + 重试那一发又被切），而同一篇笔记的速看那一光输入就 227,103 token、
 * 服务端实测 52.8 秒。讲解读的是整篇正文，短笔记上的"够用"到长笔记上就是一定为红。
 * 同一条轮次链上的互动演示早就用共享那两个声明值，只有讲解还留着自己的数。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AI_PROVIDER_TIMEOUT_MS, DEFAULT_AI_TASK_TIMEOUT_MS } from "@astella/shared";
import { createNoteTeachingExplainTaskV1 } from "../teaching/teaching-explain.ts";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };

function budget(maxDurationMs?: number) {
  return createNoteTeachingExplainTaskV1({
    provider: async () => ({ ok: false as const, class: "cancelled" as const, message: "unused" }),
    scope: scope as never,
    input: {} as never,
    maxDurationMs,
  }).budget;
}

test("本轮墙钟还够时，讲解的等待上界取共享那两个声明值，不再停在 55 秒", () => {
  // 轮次那一发预留的墙钟上限是 780 秒（`reserveRoundModelAttempt`），长笔记上这就是它该有的量。
  const step = budget(780_000);
  assert.equal(step.stepTimeoutMs, Math.min(DEFAULT_AI_PROVIDER_TIMEOUT_MS, 780_000),
    "步骤上界应贴着共享声明（15 分钟）而不是本地那个 55 秒常数");
  assert.ok((step.stepTimeoutMs ?? 0) > 110_000,
    `步骤上界 ${step.stepTimeoutMs}ms 仍然装不下一次整篇讲解——长笔记会再次固定失败`);
  assert.equal(step.taskDeadlineMs, Math.min(DEFAULT_AI_TASK_TIMEOUT_MS, 780_000));
});

test("轮次墙钟只剩一点点时照旧如实截断，不假装还有时间", () => {
  const tight = budget(40_000);
  assert.ok((tight.stepTimeoutMs ?? 0) <= 40_000,
    "共享声明不该盖过这一轮真实剩下的墙钟：装不下就按装不下算");
  assert.ok((tight.taskDeadlineMs ?? 0) <= 40_000);
});
