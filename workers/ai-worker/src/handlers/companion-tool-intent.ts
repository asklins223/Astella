import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@ailearn/shared";
import { agentTurnInterpretationProposalV1Schema, type AgentTurnInterpretationV1, type AgentAttentionObjectV1 } from "@ailearn/shared/agent-contracts";
import { resolveAgentTurnInterpretation } from "@ailearn/agent-core";
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
const TASK_VERSION = 2;
const DEFAULT_STEP_TIMEOUT_MS = 8_000;

export interface CompanionToolIntentTaskContext {
  job: JobLeaseContext;
  runId: string;
  userId: string;
  permissionLevel: string;
  currentActiveTransaction?: () => unknown;
  verifyAttempt: (attempt: AiAttemptToken) => Promise<boolean>;
  stepTimeoutMs?: number;
  requestHash?: string;
  objects?: readonly AgentAttentionObjectV1[];
  capabilities?: readonly string[];
}

function toolIntentMessages(messages: readonly ChatMessage[], taskContext: CompanionToolIntentTaskContext): ChatMessage[] | null {
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
        '你解释用户本轮的注意力，只输出 JSON：{"intent":"conversation|question|task|task_control|mixed","toolUse":"none|read|act|uncertain","subjects":[{"description":"讨论对象","objectIndex":0}],"goalRelation":"unrelated|new|continue|revise|control|discuss|unclear","goalObjectIndex":0,"candidateOperations":["真实能力名"],"ambiguities":[]}。枚举选一个值；无真实索引时省略 index 字段。',
        "objects 是宿主提供的真实对象，索引从0开始；不发明身份。目标引用只可指向agent_run。candidateOperations只从capabilities选择，是候选而非执行授权。没有对象、代词未消解或修改范围不明，记入ambiguities；只读查询可用于核对，不能猜测执行写入。",
        "当用户要查看自己的文章、笔记、图片、引用、卡片或实时信息，或要求导航、设置和执行动作时，必须先用工具；口语化、简称、代词和间接表达也一样。",
        "用户需要实际计算或核对数值、公式代入时也需要工具；只解释数学概念或聊感受可直接回答。",
        "用户给出公开文档网址并要求阅读、核对或总结时需要工具；不能靠网址标题猜正文。",
        "用户明确要求记住、以后遵循、纠正或忘记一项偏好、目标或共同记录时，需要调用记忆工具核对并保存/修订/撤回。口头说记下了、延后自动整理或只在这轮照做不能代替持久动作。一次性的表达要求没有要求长期保存时可直接按本轮执行。",
        "一般知识问答、闲聊、自我介绍以及询问操作方法可以直接回答。此前助手说过已找到或已展示，不等于本轮真的查询过。",
        "只以 current 这句话判断当前意图；recent 仅帮助理解指代。上一件任务继续在后台跑，不代表用户现在仍要做它；换到家常、寒暄或一句好，不继承旧执行指令。混合请求中有明确新任务时仍可需要工具。",
        "记录此刻讨论对象、与后台目标的关系及尚未解开的歧义。闲聊intent=conversation、toolUse=none、goalRelation=unrelated；一般解释question/none；读取自己的资料read；明确保存、生成、导航或控制act。操作参数由后续模型核对，旧任务不会因闲聊被修改。",
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify({ current, recent, objects: taskContext.objects ?? [], capabilities: taskContext.capabilities ?? [] }) },
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
 * Interpret the current subjects, goal relationship and possible operations in a
 * single structured AI step; the specialized multi-step tool loop stays in
 * companion-agent-runtime and owns tool execution and business receipts.
 */
export async function interpretCompanionTurn(
  provider: AIProvider,
  messages: readonly ChatMessage[],
  taskContext: CompanionToolIntentTaskContext,
): Promise<AgentTurnInterpretationV1> {
  const latest = [...messages].reverse().find(message => message.role === "user");
  const current = typeof latest?.content === "string" ? latest.content : JSON.stringify(latest?.content ?? "");
  const binding = { requestHash: taskContext.requestHash ?? sha256Utf8V1(current),
    objects: taskContext.objects ?? [], capabilities: taskContext.capabilities ?? [] };
  const unknown = () => resolveAgentTurnInterpretation(null, binding);
  const requestMessages = toolIntentMessages(messages, taskContext);
  if (!requestMessages) return unknown();
  const requestedStepTimeoutMs = taskContext.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  if (requestedStepTimeoutMs <= 0) return unknown();

  const inputSnapshotHash = sha256Utf8V1(canonicalJsonV1({
    taskVersion: TASK_VERSION,
    providerId: provider.id,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    messages: requestMessages,
  }));
  const stepTimeoutMs = Math.min(requestedStepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS);
  const definition: AiTaskDefinition<{ messages: ChatMessage[] }, AgentTurnInterpretationV1> = {
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
      satisfied: (output) => output.status === "interpreted" || output.status === "uncertain",
      unmetReason: "伴星未返回有效的本轮注意力解释",
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
        maxTokens: 650,
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
      const proposal = agentTurnInterpretationProposalV1Schema.safeParse(parsed);
      if (!proposal.success) return { ok: false, class: "output_shape", message: "本轮注意力解释不符合结构合同" };
      return {
        ok: true,
        output: resolveAgentTurnInterpretation(proposal.data, binding),
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

  let receipt: AiTaskReceipt<AgentTurnInterpretationV1>;
  try {
    receipt = await runAiTask(definition, {
      ctx,
      attempt,
      currentActiveTransaction: taskContext.currentActiveTransaction ?? currentWorkerWorkspaceTransaction,
      verifyAttempt: taskContext.verifyAttempt,
    });
  } catch (error) {
    if (error instanceof JobLeaseLostError) {
      if (error.reason === "aborted" || taskContext.job.signal?.aborted) return unknown();
    }
    throw error;
  }

  if (receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed") {
    return receipt.output ?? unknown();
  }
  if (receipt.failure?.class === "cancelled" || taskContext.job.signal?.aborted) return unknown();
  if (receipt.failure?.class === "lease_lost") {
    throw new JobLeaseLostError(taskContext.job.id, "inactive");
  }
  return unknown();
}
