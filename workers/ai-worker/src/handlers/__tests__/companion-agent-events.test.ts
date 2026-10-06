import assert from "node:assert/strict";
import test from "node:test";
import type { AiCheckpointKey } from "@astella/shared/ai-task-kernel";
import {
  decodeCompanionAgentStepCheckpoint,
  resolveAgentStepCountForResume,
} from "../companion-agent-events.ts";

const key: AiCheckpointKey = {
  taskId: "companion_agent_model_step",
  taskVersion: 1,
  inputSnapshotHash: "a".repeat(64),
  workspaceId: "workspace-1",
  userId: "user-1",
};

const saved = {
  key,
  entry: {
    output: {
      content: "private step output",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      providerRequestId: "request-1",
    },
    promptTokens: 0,
    completionTokens: 0,
  },
};

test("Agent 步骤检查点只对同一任务版本、输入快照和用户范围复用", () => {
  assert.deepEqual(decodeCompanionAgentStepCheckpoint(saved, key), saved.entry);
  assert.equal(decodeCompanionAgentStepCheckpoint(saved, { ...key, taskVersion: 2 }), null);
  assert.equal(decodeCompanionAgentStepCheckpoint(saved, { ...key, inputSnapshotHash: "b".repeat(64) }), null);
  assert.equal(decodeCompanionAgentStepCheckpoint(saved, { ...key, userId: "user-2" }), null);
});

test("无效或损坏的 Agent 步骤检查点只能按未命中处理", () => {
  assert.equal(decodeCompanionAgentStepCheckpoint({ ...saved, entry: { ...saved.entry, output: { content: "invalid" } } }, key), null);
  assert.equal(decodeCompanionAgentStepCheckpoint("{bad json", key), null);
});

test("lease reclaim 后从仍在运行的逻辑步骤恢复，而不是跳到下一步", () => {
  assert.equal(resolveAgentStepCountForResume({ stepCount: 3, runningStepNo: 3 }), 2);
  assert.equal(resolveAgentStepCountForResume({ stepCount: 3, runningStepNo: null }), 3);
});
