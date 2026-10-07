import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@astella/shared";
import { agentTurnInterpretationProposalV1Schema, type AgentTurnInterpretationV1, type AgentAttentionObjectV1 } from "@astella/shared/agent-contracts";
import { resolveAgentTurnInterpretation } from "@astella/agent-core";
import {
  runAiTask,
  type AiAttemptToken,
  type AiTaskContext,
  type AiTaskDefinition,
  type AiTaskReceipt,
} from "@astella/shared/ai-task-kernel";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { JobLeaseLostError, type JobLeaseContext } from "../lib/job-lease.ts";
import type { AIProvider } from "../lib/ai-provider.ts";

const TASK_ID = "companion_tool_intent";
const TASK_VERSION = 5;
/**
 * 分类步骤的单次预算（2026-10-06 起 30s）。
 *
 * 原来 8s 是"关思考 + 小输入"的延迟预算；全链路开思考后，思考 token 让同类
 * 整段取回从 7.6s 涨到 36s（摘要器实测），8s 会让分类**每轮必超时**，
 * 退化成 uncertain 之后工具面被收紧——那正是这条链最贵的失败形态。
 * 调用方传进来的 stepTimeoutMs 仍会再夹一次（见 interpretCompanionTurn）。
 */
export const COMPANION_TOOL_INTENT_TIMEOUT_MS = 30_000;

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
  dialogueFrameEnabled?: boolean;
}

/**
 * 分类器看得见的那几条历史消息。
 *
 * `index` 一律按**去掉 system 之后**的位置给——那正是运行时 `messages` 的索引空间，
 * 所以解释给出的索引可以原样交给 `renderPendingOffersAsRecords`，中间不需要再换算一次
 * （换算过一次就等于两套编号，迟早对不上）。
 */
export const CLASSIFIER_RECENT_MESSAGES = 5;

export function companionClassifierRecent(messages: readonly ChatMessage[]): Array<{
  index: number; role: string; content: string;
}> {
  const space = messages.filter((message) => message.role !== "system");
  const start = Math.max(0, space.length - CLASSIFIER_RECENT_MESSAGES);
  return space.slice(start).map((message, offset) => ({
    index: start + offset,
    role: message.role,
    content: classifierExcerpt(typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ")),
  }));
}

function classifierExcerpt(text: string): string {
  // The classifier must see both the subject and the closing invitation. This
  // marked excerpt is only for classification; generation retains full history.
  return text.length <= 1_000 ? text : `${text.slice(0, 250)}\n[中间内容省略]\n${text.slice(-750)}`;
}

/** 解释只能指向它真的看见过的那些 assistant 消息。 */
export function companionOfferCandidates(messages: readonly ChatMessage[]): number[] {
  return companionClassifierRecent(messages)
    .filter((item) => item.role === "assistant")
    .map((item) => item.index);
}

/** Full user testimony from the native replay. No assistant inference or text clipping. */
export function companionDialogueSources(messages: readonly ChatMessage[]) {
  return messages.filter(message => message.role !== "system").map((message,index) => ({
    index,role:message.role,content:typeof message.content === "string" ? message.content
      : message.content.filter(part=>part.type === "text").map(part=>part.text).join(" "),
  })).filter(message=>message.role === "user").slice(-10);
}

function toolIntentMessages(messages: readonly ChatMessage[], taskContext: CompanionToolIntentTaskContext): ChatMessage[] | null {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest) return null;
  const current = typeof latest.content === "string"
    ? latest.content
    : latest.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  const recent = companionClassifierRecent(messages);
  const userRecords = taskContext.dialogueFrameEnabled ? companionDialogueSources(messages) : undefined;
  return [
    {
      role: "system",
      content: [
        '你解释用户本轮的注意力，只输出 JSON：{"intent":"conversation|question|task|task_control|mixed","toolUse":"none|read|act|uncertain","subjects":[],"goalRelation":"unrelated|new|continue|revise|control|discuss|unclear","candidateOperations":[],"ambiguities":[],"pendingOfferIndexes":[]}。枚举选一个值；有确实需要定位的讨论对象时才加 {"description":"讨论对象"}，只有 objects 中存在对应真实对象时才加 objectIndex；goalObjectIndex 同理，未指向真实目标时省略。',
        "objects 是宿主提供的真实对象，索引从0开始；不发明身份。目标引用只可指向agent_run。candidateOperations只从capabilities选择，是候选而非执行授权。没有对象、代词未消解或修改范围不明，记入ambiguities；只读查询可用于核对，不能猜测执行写入。",
        "当用户要查看自己的文章、笔记、图片、引用、卡片或实时信息，或要求导航、设置和执行动作时，必须先用工具；口语化、简称、代词和间接表达也一样。",
        "用户需要实际计算或核对数值、公式代入时也需要工具；只解释数学概念或聊感受可直接回答。",
        "用户给出公开文档网址并要求阅读、核对或总结时需要工具；不能靠网址标题猜正文。",
        "用户明确要求记住、以后遵循、纠正或忘记一项偏好、目标或共同记录时，需要调用记忆工具核对并保存/修订/撤回。口头说记下了、延后自动整理或只在这轮照做不能代替持久动作。一次性的表达要求没有要求长期保存时可直接按本轮执行。",
        "一般知识问答、闲聊、自我介绍以及询问操作方法可以直接回答。此前助手说过已找到或已展示，不等于本轮真的查询过。",
        "称呼伴星、随口招呼、情绪表达和角色口味是对话内容，不要求在 objects 中找到数据库身份。没有资料读取或操作目标时，不因为话题名词或昵称没对应 object 就制造歧义；普通招呼可用 conversation/none、subjects 空数组。只有会影响所问资料或操作目标的歧义才要求澄清。",
        "区分角色口味和真实经历：询问伴星喜欢什么可以是conversation/none；询问今天看到、经历、查到或做成了什么是在核对记录，应为question。recent里有可分享的真实共同交流时可以none；需要查更早记录时read。没有记录也不能把这种问题降成随口编故事的闲聊，更不能把人格示例当成实际经历。",
        "只以 current 这句话判断当前意图；recent 仅帮助理解指代。上一件任务继续在后台跑，不代表用户现在仍要做它；换到家常、寒暄或一句好，不继承旧执行指令。混合请求中有明确新任务时仍可需要工具。",
        "记录此刻讨论对象、与后台目标的关系及尚未解开的歧义。闲聊intent=conversation、toolUse=none、goalRelation=unrelated；一般解释question/none；读取自己的资料read；明确保存、生成、导航或控制act。操作参数由后续模型核对，旧任务不会因闲聊被修改。",
        "pendingOfferIndexes：recent 里某条 assistant 消息**结尾留着一个用户这句话没有接的邀请、提议或等待**（例如「要不要接着往下讲」「我随时接」「就等你说下一步」「还需要我展开吗」），就把那条消息的 index 放进去；陈述句和问句都算，判据是「它还在等她回应」。窗口里**每一条**这样的消息都要列出来，不要只报最近那一条。用户接了、照做了，或她已经明说不用回应（「先放着」「不催你」「不想管也行」），就不放。只引用 recent 给过的 index，没有就返回空数组。",
        ...(userRecords ? [
          '同时给出 dialogueFrame:{"purpose":"greeting|sharing|venting|seeking_help|correction|preference|factual_question|other","evidence":{"messageIndex":0,"quote":"current中的连续原话"},"userState":[{"topic":"话题名","aspect":"progress|timing|preference|decision|other","relation":"statement|correction","messageIndex":0,"quote":"userRecords中的连续原话"}]}。这里只是结构说明，索引和原话必须按实际记录选，不照填0。',
          "purpose 描述 current 在做什么：招呼、分享、吐槽、求办法、纠正、聊口味或观点、核对事实。分享困难或疲惫不自动是求办法；普通疑问不自动在求建议。用途可以与工具意图并存，不改变权限。evidence 必须引用最后一条用户消息，不能引用助手。",
          "userState 只选当前话题仍相关的用户自述：事实阶段、时间、偏好或决定。每项 quote 原样摘取连续短句（最多320字符），不能改写、拼接或补出结果；只引用 userRecords 给过的 index。助手的猜测、安慰、例子不能成为用户状态。用户纠正后选新的原话，同一话题保持同一个topic名；不同方面用aspect区分。不确定或没有相关状态就返回空数组。",
          "延续一个话题时，保留仍成立的明确进展、时间与决定。progress 只记录动作做到的阶段；对质量的评价、感受和吐槽属于other，不能覆盖完成阶段。新的同方面陈述没有明确更新状态时，不拿它替换旧进展。后来明确了先前指代的对象时，相关旧原话也用已确认的同一topic名。",
          'aspect=progress 的条目补 progress:{"work":"not_started|in_progress|completed|unknown","handoff":"not_handed_off|handed_off|unknown"}。work描述事情是否做完，handoff描述是否交付/提交/发出，这是不同阶段。只说完成不能证明已经交付，未明确交付状态时handoff=unknown；明确还没交是not_handed_off，明确已交才是handed_off。原话和阶段解读都不能猜补后续结果。其他aspect不加progress。',
          '每条状态补 relevance:"foreground|background"。foreground 是 current 正在聊或核对的对象；旧话题仅帮助理解转场时是background。保留本轮明确的新决定或状态，不能只列旧事情来替代current。背景中的未完事项不代表当前要继续做它。quote 选支持这一aspect的最小连续原话，不把不同方面混成一条。',
          "进展的topic要定位到原话明确做到的具体活动，不能笼统扩大成整个多步骤项目。比如备料完成与烹饪完成是不同活动；前置步骤做完不证明后续步骤或整体做完。相关时间和交付也绑定同一具体活动，不把项目名称当作完成范围。",
        ] : []),
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify({ current, recent, userRecords, objects: taskContext.objects ?? [], capabilities: taskContext.capabilities ?? [] }) },
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
    objects: taskContext.objects ?? [], capabilities: taskContext.capabilities ?? [],
    offerCandidates: companionOfferCandidates(messages),
    dialogueSources:taskContext.dialogueFrameEnabled ? companionDialogueSources(messages) : undefined,
    currentMessageIndex:messages.filter(message=>message.role !== "system").length-1 };
  const unknown = () => resolveAgentTurnInterpretation(null, binding);
  const requestMessages = toolIntentMessages(messages, taskContext);
  if (!requestMessages) return unknown();
  const requestedStepTimeoutMs = taskContext.stepTimeoutMs ?? COMPANION_TOOL_INTENT_TIMEOUT_MS;
  if (requestedStepTimeoutMs <= 0) return unknown();

  const inputSnapshotHash = sha256Utf8V1(canonicalJsonV1({
    taskVersion: TASK_VERSION,
    providerId: provider.id,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    messages: requestMessages,
  }));
  const stepTimeoutMs = Math.min(requestedStepTimeoutMs, COMPANION_TOOL_INTENT_TIMEOUT_MS);
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
        // 900：这一格输出只有一两百 token 的分类 JSON。2026-10-06 之前为了容纳
        // 思考把它提到 2000，但**这一轮开不开思考正是由这一步决定的**——分类器
        // 自己开高档，闲聊轮就先白等十几秒（它在每一轮的关键路径上）。
        maxTokens: taskContext.dialogueFrameEnabled ? 4_000 : 900,
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
