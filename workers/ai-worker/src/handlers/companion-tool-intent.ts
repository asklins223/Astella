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
  type AiTaskOutcome,
  type AiTaskFailureClass,
} from "@astella/shared/ai-task-kernel";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { JobLeaseLostError, type JobLeaseContext } from "../lib/job-lease.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import { DEFAULT_AI_PROVIDER_TIMEOUT_MS, getCompanionAgentTool } from "@astella/shared";
import { boundCompanionRecentHistory, type CompanionRecentHistoryMessage } from "./companion-context-handoff.ts";
import { conversationInstant, type CompanionConversationClock } from "./companion-conversation-evidence.ts";

const TASK_ID = "companion_tool_intent";
const TASK_VERSION = 12;
/**
 * 分类器关闭思考、单次调用且不自行重试。调用等待使用公共模型上限；
 * 超时仍保留 uncertain，不能据此把可能需要读取资料的请求当作闲聊。
 * 调用方的剩余整轮预算会进一步收紧这个上限。
 */
export const COMPANION_TOOL_INTENT_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;

/** Only execution metadata may leave this step; no input, output or error prose. */
export interface CompanionToolIntentReceipt {
  outcome: AiTaskOutcome;
  failureClass: AiTaskFailureClass | null;
  interpretationStatus: AgentTurnInterpretationV1["status"] | null;
  elapsedMs: number;
  modelCalls: number;
}

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
  recentMessages?: readonly CompanionRecentHistoryMessage[];
  conversationClock?: CompanionConversationClock;
  onReceipt?: (receipt: CompanionToolIntentReceipt) => void;
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
    content: typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join(" "),
  }));
}

/** 解释只能指向它真的看见过的那些 assistant 消息。 */
export function companionOfferCandidates(messages: readonly ChatMessage[]): number[] {
  return companionClassifierRecent(messages)
    .filter((item) => item.role === "assistant")
    .map((item) => item.index);
}

function toolIntentMessages(messages: readonly ChatMessage[], taskContext: CompanionToolIntentTaskContext): ChatMessage[] | null {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest) return null;
  const current = typeof latest.content === "string"
    ? latest.content
    : latest.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  const recent = companionClassifierRecent(messages);
  const history = boundCompanionRecentHistory([...(taskContext.recentMessages ?? [])]);
  const native = messages.filter(message => message.role !== "system");
  const timedRecent = recent.map(item => {
    const source = history[item.index];
    // The classifier and native dialogue must agree on both position and text.
    // Mismatched/absent metadata stays unknown rather than acquiring a false date.
    const createdAt = history.length === native.length - 1
      && source?.role === item.role && source.text === item.content
      ? conversationInstant(source.createdAt) : null;
    return { ...item, createdAt };
  });
  return [
    {
      role: "system",
      content: [
        '你解释用户本轮的注意力，只输出 JSON：{"intent":"conversation|question|task|task_control|mixed","toolUse":"none|read|act|uncertain","subjects":[],"goalRelation":"unrelated|new|continue|revise|control|discuss|unclear","candidateOperations":[],"ambiguities":[],"pendingOfferIndexes":[]}。枚举选一个值；有确实需要定位的讨论对象时才加 {"description":"讨论对象"}，只有 objects 中存在对应真实对象时才加 objectIndex；goalObjectIndex 同理，未指向真实目标时省略。',
        "objects 是宿主提供的当前页面对象及相关后台目标，索引从0开始；不发明身份。目标引用只可指向agent_run。capabilities 给出本轮工具的 name、description 与 riskClass；candidateOperations只填其中的name，是候选而非执行授权。没有对象、代词未消解或修改范围不明，记入ambiguities；只读查询可用于核对，不能猜测执行写入。",
        "当用户要查看自己的文章、笔记、图片、引用、卡片或实时信息，或要求导航、设置和执行动作时，必须先用工具；口语化、简称、代词和间接表达也一样。",
        "用户需要实际计算或核对数值、公式代入时也需要工具；只解释数学概念或聊感受可直接回答。",
        "当 capabilities 含 agent_web_search 时，用户要联网查找公开资料、核实事实或查询最新信息，用question/read，并将agent_web_search记入候选；普通知识解释和闲聊仍可直接回答。未提供该能力时不要声称能联网。",
        "用户给出公开文档网址并要求阅读、核对或总结时需要工具；不能靠网址标题猜正文。",
        "用户明确要求记住、以后遵循、纠正或忘记一项偏好、目标或共同记录时，需要调用记忆工具核对并保存/修订/撤回。口头说记下了、延后自动整理或只在这轮照做不能代替持久动作。一次性的表达要求没有要求长期保存时可直接按本轮执行。",
        "用户明确要求你以后改变语气、节奏、举例习惯等长期表达方式时，是task/act；能力表有companion_revise_own_style时将它记入候选。事实纠正、单次抱怨和只约束这一轮的篇幅不自动变成长期人格修订。",
        "普通招呼是conversation/none、goalRelation=unrelated；页面、旧任务和旧邀请不把招呼变成进度查询。用户只在纠正你刚才的话（时间、对象、完成范围）时，先采用本轮纠正；已有对话原文与发送时间足以理解的，是conversation/none，不为了证明改口而额外查询动态或旧历史。用户确实要求核对某项外部记录、现有证据不足时才read；要长期修订保存的记忆时仍act。recent.createdAt和conversationClock是服务器发送时间证据，不直接证明消息所描述的外部事件时间；没有时间证据不猜日期。",
        "一般知识问答、闲聊、自我介绍以及询问操作方法可以直接回答。此前助手说过已找到或已展示，不等于本轮真的查询过。",
        "区分直接写回复与操作项目数据：要求在回复里写故事、诗、对话、示例或文案草稿，是task/none，不需要工具，goalRelation=unrelated、candidateOperations为空。要求把它保存到笔记、生成学习卡、修改已有资料或读取指定来源，才需要相应工具；不要把纯文本创作中的‘写/生成’自动解释成数据库写入。",
        "用户要求生成项目里的速看、互动演示、往外学/拓展笔记草稿或学习卡时，是生成真实产物的task/act、goalRelation=new；不要求用户再说‘保存’或指定保存位置。capabilities里提供agent_start_goal时，用它接下生成目标；专业生成工具在后台使用，不因它们没直接出现在聊天工具表里就认定能力缺失。用户明确只要在聊天里解释、概括或列方向时，才按直接文字回答或读取资料处理。历史助手说过能力没接上、不能保存，不是当前能力事实，以本轮capabilities为准。",
        "用户明确要求调整、整理、规范或优化当前笔记的格式/排版，把标题改成真正标题、代码改成代码块，或插入、补充、删除、替换正文、转换为表格或流程图时，是task/act，候选companion_edit_note，goalRelation=unrelated。‘调整下这篇笔记的格式规范，例如代码的要转成代码块，标题的要转标题’已经要求实际修改，不是只分析问题；‘改一下’与‘调整一下’含义相同，不要求用户额外说保存。用户明确说全文/整篇，或指向整篇笔记且没有局部限制时，范围是整篇，无需选区或光标。只问有哪些问题、怎么调整，或明确只给建议/先别改时才按question/read。这是直接修改正文，不需要agent_run目标引用，即使是重试上一轮编辑也不能标为continue而要求后台目标。当前页面唯一note/note_version就是编辑对象；光标和选区是它内部的位置，无需另找对象身份。它不新建笔记、不启动速看或互动演示目标。普通解释和原句解读不修改正文。",
        "用户要求将刚讨论的知识点总结、整理或保存为一篇库内新笔记时，是task/act、goalRelation=new，候选companion_create_note；它不需要已有笔记作为起点。‘这个知识点’可由recent中的当前讨论定位，不因没有note对象就制造材料歧义。只问能不能做、操作方法或只要回复里的总结仍可直接回答；不要把普通知识问答自动保存。新笔记可检索并链接库内相关笔记，这是创建笔记的一部分，不等同于基于已有笔记生成拓展草稿。",
        "用户要求把某篇笔记共享给空间、让别人能看到，或取消共享收回来时，是task/act、候选companion_share_note；哪一篇由本轮搜索、读取或当前页面定位，不因用户没说出标题就制造材料歧义。只问谁能看到、或问在哪儿操作仍可直接回答。这句话与别的请求一起出现时，各自按自己的候选记，不要因为其中一项没有对应能力就把整句判成不确定。",
        "当前页面有唯一note或note_version对象、用户说‘这篇笔记’或省略笔记名称请求速看/拓展时，可以用该对象的objectIndex定位材料；note_version已经包含真实笔记及版本。未指定其他材料时，不凭空要求笔记名、版本或保存位置，也不把当前笔记新生成的请求当成延续一个不存在的agent_run。用户明确指向别的材料或有多个可能对象时才核对指代。",
        "称呼伴星、随口招呼、情绪表达和角色口味是对话内容，不要求在 objects 中找到数据库身份。没有资料读取或操作目标时，不因为话题名词或昵称没对应 object 就制造歧义；普通招呼可用 conversation/none、subjects 空数组。只有会影响所问资料或操作目标的歧义才要求澄清。",
        "区分角色口味和真实经历：询问伴星喜欢什么可以是conversation/none；询问今天看到、经历、查到或做成了什么是在核对记录，应为question。recent里有可分享的真实共同交流时可以none；需要查更早记录时read。没有记录也不能把这种问题降成随口编故事的闲聊，更不能把人格示例当成实际经历。",
        "只以 current 这句话判断当前意图；recent 仅帮助理解指代。上一件任务继续在后台跑，不代表用户现在仍要做它；换到家常、寒暄或一句好，不继承旧执行指令。混合请求中有明确新任务时仍可需要工具。",
        "记录此刻讨论对象、与后台目标的关系及尚未解开的歧义。闲聊intent=conversation、toolUse=none、goalRelation=unrelated；一般解释question/none；直接文本创作task/none；读取自己的资料read；明确保存、生成项目对象、导航或控制act。操作参数由后续模型核对，旧任务不会因闲聊被修改。",
        "pendingOfferIndexes：recent 里某条 assistant 消息**结尾留着一个用户这句话没有接的邀请、提议或等待**（例如「要不要接着往下讲」「我随时接」「就等你说下一步」「还需要我展开吗」），就把那条消息的 index 放进去；陈述句和问句都算，判据是「它还在等她回应」。窗口里**每一条**这样的消息都要列出来，不要只报最近那一条。用户接了、照做了，或她已经明说不用回应（「先放着」「不催你」「不想管也行」），就不放。只引用 recent 给过的 index，没有就返回空数组。",
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify({ current, recent: timedRecent,
      conversationClock: taskContext.conversationClock ?? null, objects: taskContext.objects ?? [],
      capabilities: (taskContext.capabilities ?? []).map(name => {
        const definition = getCompanionAgentTool(name);
        return definition ? { name, description: definition.description, riskClass: definition.riskClass } : { name };
      }) }) },
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
    offerCandidates: companionOfferCandidates(messages) };
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
        maxTokens: 900,
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

  taskContext.onReceipt?.({
    outcome: receipt.outcome,
    failureClass: receipt.failure?.class ?? null,
    interpretationStatus: receipt.output?.status ?? null,
    elapsedMs: receipt.usage.elapsedMs,
    modelCalls: receipt.modelCalls,
  });

  if (receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed") {
    return receipt.output ?? unknown();
  }
  if (receipt.failure?.class === "cancelled" || taskContext.job.signal?.aborted) return unknown();
  if (receipt.failure?.class === "lease_lost") {
    throw new JobLeaseLostError(taskContext.job.id, "inactive");
  }
  return unknown();
}
