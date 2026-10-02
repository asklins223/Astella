import assert from "node:assert/strict";
import test from "node:test";
import { JobLeaseLostError } from "../../lib/job-lease.ts";
import { runWorkerAiTask, runWorkerEmbeddingTask } from "../worker-ai-task.ts";

function taskOptions() {
  return {
    job: {
      id: "job-worker-ai-task-test",
      workspaceId: "workspace-worker-ai-task-test",
      requestedBy: "user-worker-ai-task-test",
      leaseToken: "lease-worker-ai-task-test",
      signal: new AbortController().signal,
    },
    userId: "user-worker-ai-task-test",
    taskId: "note_overview_chunk",
    taskVersion: 1,
    idempotencyKey: "note-overview:test:chunk:0",
    inputSnapshotRef: { kind: "note_version" as const, id: "note-version-test", hash: "snapshot-hash" },
    input: { prompt: "explain this note" },
    modelId: "test-model",
    promptVersion: "test-prompt-v1",
    resourceClass: "interactive_ai",
    timeoutMs: 1_000,
    currentActiveTransaction: () => undefined,
    verifyAttempt: async () => true,
    execute: async () => ({ ok: true as const, output: "explained" }),
  };
}

test("worker 模型步骤在事务外通过公共内核并于调用前后核对租约", async () => {
  let transactionReads = 0;
  let leaseChecks = 0;
  let calls = 0;
  const output = await runWorkerAiTask({
    ...taskOptions(),
    currentActiveTransaction: () => {
      transactionReads += 1;
      return undefined;
    },
    verifyAttempt: async () => {
      leaseChecks += 1;
      return true;
    },
    execute: async (_input, signal) => {
      calls += 1;
      assert.ok(signal instanceof AbortSignal);
      return { ok: true, output: "explained" };
    },
  });
  assert.equal(output, "explained");
  assert.equal(calls, 1);
  assert.equal(leaseChecks, 2);
  assert.equal(transactionReads, 1);
});

test("租约失效时不执行 worker 模型步骤", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkerAiTask({
      ...taskOptions(),
      verifyAttempt: async () => false,
      execute: async () => {
        calls += 1;
        return { ok: true, output: "must not run" };
      },
    }),
    (error) => error instanceof JobLeaseLostError && error.reason === "inactive",
  );
  assert.equal(calls, 0);
});

test("worker 模型步骤保留领域输出错误供原有任务失败策略处理", async () => {
  const outputError = new Error("速看结果缺少可核对的结构化内容");
  await assert.rejects(
    runWorkerAiTask({
      ...taskOptions(),
      execute: async () => { throw outputError; },
    }),
    (error) => error === outputError,
  );
});

test("模型步骤失败时若租约也已失效，优先终止旧尝试并停止领域降级", async () => {
  let leaseChecks = 0;
  await assert.rejects(
    runWorkerAiTask({
      ...taskOptions(),
      verifyAttempt: async () => {
        leaseChecks += 1;
        return leaseChecks === 1;
      },
      execute: async () => { throw new Error("provider unavailable"); },
    }),
    (error) => error instanceof JobLeaseLostError && error.reason === "inactive",
  );
  assert.equal(leaseChecks, 2);
});

test("可修复输出错误按声明预算由内核重试一次", async () => {
  const retryIndices: number[] = [];
  const output = await runWorkerAiTask({
    ...taskOptions(),
    maxModelCalls: 2,
    maxAutoRetries: 1,
    execute: async (_input, _signal, retryIndex) => {
      retryIndices.push(retryIndex);
      if (retryIndex === 0) return { ok: false, class: "output_shape", message: "invalid json" };
      return { ok: true, output: "repaired" };
    },
  });
  assert.equal(output, "repaired");
  assert.deepEqual(retryIndices, [0, 1]);
});

test("embedding 步骤经公共内核执行、传递取消信号并保留空向量结果", async () => {
  let leaseChecks = 0;
  let calls = 0;
  const result = await runWorkerEmbeddingTask({
    job: taskOptions().job,
    userId: taskOptions().userId,
    taskId: "companion_memory_query_embedding",
    taskVersion: 1,
    idempotencyKey: "memory-query:test",
    inputSnapshotId: "run-test:memory-query",
    text: "今天聊到的内容",
    modelId: "embedding-model-v1",
    promptVersion: "memory-query-embedding-v1",
    resourceClass: "interactive_ai",
    timeoutMs: 1_000,
    currentActiveTransaction: () => undefined,
    verifyAttempt: async () => {
      leaseChecks += 1;
      return true;
    },
    embed: async (text, signal) => {
      calls += 1;
      assert.equal(text, "今天聊到的内容");
      assert.ok(signal instanceof AbortSignal);
      return null;
    },
  });
  assert.equal(result, null);
  assert.equal(calls, 1);
  assert.equal(leaseChecks, 2);
});
