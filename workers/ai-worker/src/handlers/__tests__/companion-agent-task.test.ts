import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnRequest, AgentTurnResult } from "@ailearn/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { JobLeaseLostError } from "../../lib/job-lease.ts";
import { runCompanionAgentModelStep } from "../companion-agent-task.ts";

function taskContext(signal = new AbortController().signal) {
  return {
    job: {
      id: "job-agent-step-test",
      workspaceId: "workspace-agent-step-test",
      requestedBy: "user-agent-step-test",
      leaseToken: "lease-agent-step-test",
      signal,
    },
    runId: "run-agent-step-test",
    stepId: "step-agent-step-test",
    userId: "user-agent-step-test",
    permissionLevel: "guided",
    request: {
      role: "companion_agent",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "你好" }],
      tools: [],
      maxTokens: 128,
      temperature: 0.4,
    } as AgentTurnRequest,
    provider: {
      id: "test",
      modelId: "test-model",
      promptVersion: "test-prompt-v1",
    } as AIProvider,
    timeoutMs: 1_000,
    currentActiveTransaction: () => undefined,
    verifyAttempt: async () => true,
  };
}

function result(content = "你好"): AgentTurnResult {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    providerRequestId: "request-1",
  };
}

test("一个 Agent 模型步通过公共内核，事务外执行且调用前后核对租约", async () => {
  let calls = 0;
  let leaseChecks = 0;
  let transactionReads = 0;
  const context = taskContext();
  const output = await runCompanionAgentModelStep({
    ...context,
    currentActiveTransaction: () => {
      transactionReads += 1;
      return undefined;
    },
    verifyAttempt: async () => {
      leaseChecks += 1;
      return true;
    },
    execute: async (signal) => {
      calls += 1;
      assert.ok(signal instanceof AbortSignal);
      return result();
    },
  });
  assert.deepEqual(output, result());
  assert.equal(calls, 1);
  assert.equal(leaseChecks, 2);
  assert.equal(transactionReads, 1);
});

test("租约失效时不执行 Agent 模型步", async () => {
  let calls = 0;
  await assert.rejects(
    runCompanionAgentModelStep({
      ...taskContext(),
      verifyAttempt: async () => false,
      execute: async () => {
        calls += 1;
        return result();
      },
    }),
    (error) => error instanceof JobLeaseLostError && error.reason === "inactive",
  );
  assert.equal(calls, 0);
});

test("匹配的 Agent 模型步检查点恢复结果且不重复调用模型", async () => {
  let calls = 0;
  const expected = result("已经保存的结果");
  const output = await runCompanionAgentModelStep({
    ...taskContext(),
    checkpoint: {
      load: async () => ({ output: expected, promptTokens: 4, completionTokens: 2 }),
      save: async () => { throw new Error("a resumed checkpoint must not be written again"); },
    },
    execute: async () => {
      calls += 1;
      return result();
    },
  });
  assert.deepEqual(output, expected);
  assert.equal(calls, 0);
});

test("内核回执保留 Provider 错误对象供现有流式回退策略判别", async () => {
  const providerError = Object.assign(new Error("upstream unavailable"), { providerCode: "UPSTREAM_TIMEOUT" });
  await assert.rejects(
    runCompanionAgentModelStep({
      ...taskContext(),
      execute: async () => { throw providerError; },
    }),
    (error) => error === providerError,
  );
});
