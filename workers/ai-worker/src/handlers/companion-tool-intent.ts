import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@ailearn/shared";
import {
  runAiTask,
  type AiAttemptToken,
  type AiTaskContext,
  type AiTaskDefinition,
  type AiTaskReceipt,
} from "@ailearn/shared/ai-task-kernel";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { JobLeaseLostError, type JobLeaseContext } from "../lib/job-lease.ts";
import type { AIProvider } from "../lib/ai-provider.ts";

const TASK_ID = "companion_tool_intent";
const TASK_VERSION = 1;
const DEFAULT_STEP_TIMEOUT_MS = 8_000;

export interface CompanionToolIntentTaskContext {
  job: JobLeaseContext;
  runId: string;
  userId: string;
  permissionLevel: string;
  currentActiveTransaction?: () => unknown;
  verifyAttempt: (attempt: AiAttemptToken) => Promise<boolean>;
  stepTimeoutMs?: number;
}

function toolIntentMessages(messages: readonly ChatMessage[]): ChatMessage[] | null {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest) return null;
  const current = typeof latest.content === "string"
    ? latest.content
    : latest.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  const recent = messages.filter((message) => message.role !== "system").slice(-5).map((message) => ({
    role: message.role,
    content: typeof message.content === "string"
      ? message.content.slice(0, 500)
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 500),
  }));
  return [
    {
      role: "system",
      content: [
        "你只判断下一步是否必须调用应用工具。只输出 JSON：{\"needsTool\":true} 或 {\"needsTool\":false}。",
        "当用户要查看自己的文章、笔记、图片、引用、卡片或实时信息，或要求导航、设置和执行动作时，必须先用工具；口语化、简称、代词和间接表达也一样。",
        "一般知识问答、闲聊、自我介绍以及询问操作方法可以直接回答。此前助手说过已找到或已展示，不等于本轮真的查询过。",
        "只以 current 这句话判断当前意图；recent 仅帮助理解指代。上一件任务继续在后台跑，不代表用户现在仍要做它；换到家常、寒暄或一句好，不继承旧执行指令。混合请求中有明确新任务时仍可需要工具。",
        "这里只判断是否需要工具；具体调用哪个工具和参数由后续模型自己决定。",
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify({ current, recent }) },
  ];
}

function committedIntentTask<T>(output: T): AiTaskReceipt<T> {
  return {
    outcome: "committed",
    output,
    usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
    failure: null,
    preservedValidResult: false,
    resumedFromCheckpoint: false,
    modelCalls: 0,
  };
}

/**
 * Classify whether the current request needs an application tool. This is a
 * single structured AI step; the specialized multi-step tool loop stays in
 * companion-agent-runtime and owns tool execution and business receipts.
 */
export async function companionNeedsTool(
  provider: AIProvider,
  messages: readonly ChatMessage[],
  taskContext: CompanionToolIntentTaskContext,
): Promise<boolean | null> {
  const requestMessages = toolIntentMessages(messages);
  if (!requestMessages) return false;
  const requestedStepTimeoutMs = taskContext.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  if (requestedStepTimeoutMs <= 0) return null;

  const inputSnapshotHash = sha256Utf8V1(canonicalJsonV1({
    taskVersion: TASK_VERSION,
    providerId: provider.id,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    messages: requestMessages,
  }));
  const stepTimeoutMs = Math.min(requestedStepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS);
  const definition: AiTaskDefinition<{ messages: ChatMessage[] }, boolean> = {
    id: TASK_ID,
    version: TASK_VERSION,
    mode: "structured",
    resourceClass: "interactive_ai",
    budget: {
      maxModelCalls: 1,
      stepTimeoutMs,
      taskDeadlineMs: stepTimeoutMs,
      maxAutoRetries: 0,
    },
    completion: {
      kind: "custom",
      satisfied: (output) => typeof output === "boolean",
      unmetReason: "伴星工具意图分类器未返回布尔结果",
    },
    usageContext: {
      modelId: provider.modelId,
      promptVersion: `${provider.promptVersion}:companion-tool-intent-v${TASK_VERSION}`,
      resourceClass: "interactive_ai",
    },
    prepare: async (_ctx, attempt) => {
      if (!(await taskContext.verifyAttempt(attempt))) {
        throw new JobLeaseLostError(
          taskContext.job.id,
          taskContext.job.signal?.aborted ? "aborted" : "inactive",
        );
      }
      return { messages: requestMessages };
    },
    execute: async (input, env) => {
      const answer = await provider.chatCompletion(input.messages, {
        maxTokens: 60,
        temperature: 0,
        responseFormat: "json_object",
        disableThinking: true,
      }, env.signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer.content);
      } catch {
        return { ok: false, class: "output_shape", message: "工具意图分类器没有返回有效 JSON" };
      }
      if (!parsed || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).needsTool !== "boolean") {
        return { ok: false, class: "output_shape", message: "工具意图分类器缺少布尔 needsTool 字段" };
      }
      return {
        ok: true,
        output: (parsed as { needsTool: boolean }).needsTool,
        promptTokens: answer.usage?.promptTokens ?? undefined,
        completionTokens: answer.usage?.completionTokens ?? undefined,
      };
    },
    commit: async (_ctx: AiTaskContext, _attempt: AiAttemptToken, output) => committedIntentTask(output),
  };
  const ctx: AiTaskContext = {
    workspaceId: taskContext.job.workspaceId,
    userId: taskContext.userId,
    inputSnapshotRef: {
      kind: "task",
      id: `${taskContext.runId}:${TASK_ID}`,
      hash: inputSnapshotHash,
    },
    permissionLevel: taskContext.permissionLevel,
    signal: taskContext.job.signal,
  };
  const attempt: AiAttemptToken = {
    taskId: definition.id,
    taskVersion: definition.version,
    attemptId: randomUUID(),
    leaseToken: taskContext.job.leaseToken,
    idempotencyKey: `companion:${taskContext.runId}:${TASK_ID}:${inputSnapshotHash}`,
    workspaceId: taskContext.job.workspaceId,
    userId: taskContext.userId,
  };

  let receipt: AiTaskReceipt<boolean>;
  try {
    receipt = await runAiTask(definition, {
      ctx,
      attempt,
      currentActiveTransaction: taskContext.currentActiveTransaction ?? currentWorkerWorkspaceTransaction,
      verifyAttempt: taskContext.verifyAttempt,
    });
  } catch (error) {
    if (error instanceof JobLeaseLostError) {
      if (error.reason === "aborted" || taskContext.job.signal?.aborted) return null;
    }
    throw error;
  }

  if (receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed") {
    return typeof receipt.output === "boolean" ? receipt.output : null;
  }
  if (receipt.failure?.class === "cancelled" || taskContext.job.signal?.aborted) return null;
  if (receipt.failure?.class === "lease_lost") {
    throw new JobLeaseLostError(taskContext.job.id, "inactive");
  }
  return null;
}
