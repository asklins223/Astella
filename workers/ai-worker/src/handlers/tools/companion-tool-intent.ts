import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@astella/shared";
import { agentTurnInterpretationProposalV1Schema, type AgentTurnInterpretationV1, type AgentAttentionObjectV1 } from "@astella/shared/agent-contracts";
import { QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION, QWEN_TTS_SUPPORTED_DIALECTS } from "@astella/shared/tts-voice-catalog";
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
import { currentWorkerWorkspaceTransaction } from "../../db.ts";
import { JobLeaseLostError, type JobLeaseContext } from "../../lib/job-lease.ts";
import { resolveClassifierHedgeDelayMs, runHedgedCall } from "../../lib/hedged-call.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { getCompanionAgentTool,
  COMPANION_AGENT_TOOL_LABELS, COMPANION_AGENT_TOOL_DISCOVERY } from "@astella/shared";
import { boundCompanionRecentHistory, type CompanionRecentHistoryMessage } from "../context/companion-context-handoff.ts";
import { conversationInstant, type CompanionConversationClock } from "../turn/companion-conversation-evidence.ts";

const TASK_ID = "companion_tool_intent";
const TASK_VERSION = 22;
/**
 * 分类器等待上限（2026-10-17）。
 *
 * 它原来直接借 `DEFAULT_AI_PROVIDER_TIMEOUT_MS`（**15 分钟**）——那是通用模型调用的
 * 上限，对一个只回一小段 JSON 的分类步骤没有任何意义。分类器同时是投机首步的
 * **放行闸**：它不回来，已经生成好的开口一个字都发不出去，用户对着空气泡干等。
 *
 * 这里的数不是"慢"的判据，是"真的挂死"的判据：实测分类器往返 2.2–11 s（今天的
 * 真实分类器请求），20 s 已越过观测到的尾部。超时后 `resolveAgentTurnInterpretation(null)`
 * 退回 `toolUse=uncertain`，**工具面不因意图收窄**（consequential 仍走确认门），
 * 所以漏放的代价是保守而不是误执行。生产 p99 从审计库拉出来之后按 p99×2–3 重新定，
 * 不在这里拍最终值；调用方剩余的整轮预算仍会进一步收紧它。
 */
export const COMPANION_TOOL_INTENT_TIMEOUT_MS = 20_000;

/** Only execution metadata may leave this step; no input, output or error prose. */
export interface CompanionToolIntentReceipt {
  outcome: AiTaskOutcome;
  failureClass: AiTaskFailureClass | null;
  interpretationStatus: AgentTurnInterpretationV1["status"] | null;
  elapsedMs: number;
  modelCalls: number;
  /** 这次分类是否真的并发了两条上游请求（对冲）。只有 hedged 时才有这个键。 */
  hedged?: boolean;
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

/**
 * 分类器的任务只是从面里挑候选 name，所以给它 `label`（平均 7.6 字的短说法）而不是
 * 整份 description：2026-10-11 实测这份载荷 4,480 → 1,456 token，每一轮都付。
 * 同批 30 条对照里，编造面外名字 0 条、写候选 0.37→0.43 且从不重复，
 * 「声称 act 却没点名任何工具」由 2 条降到 0（见方案 52 §4.5）。
 *
 * 2026-10-18 又试了"连 label 也去掉、只留 name"：载荷 8,800→4,393 字符、
 * p50 3,174→2,973ms（网关抖动下 p90 不可比），**放行判定 20/20 完全一致**。
 * 只省 200ms，不动了——分类器的成本在网关排队，不在载荷。
 */
function companionIntentCapabilityEntry(name: string): Record<string, unknown> {
  const definition = getCompanionAgentTool(name);
  if (!definition) return { name };
  return { name, riskClass: definition.riskClass, label: COMPANION_AGENT_TOOL_LABELS[name],
    ...(COMPANION_AGENT_TOOL_DISCOVERY[name] ? { discovery: COMPANION_AGENT_TOOL_DISCOVERY[name] } : {}) };
}

export function buildCompanionTurnInterpretationMessages(
  messages: readonly ChatMessage[],
  taskContext: Pick<CompanionToolIntentTaskContext, "objects" | "capabilities" | "recentMessages" | "conversationClock">,
): ChatMessage[] | null {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest) return null;
  const current = typeof latest.content === "string"
    ? latest.content
    : latest.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  const recent = companionClassifierRecent(messages);
  const history = boundCompanionRecentHistory([...(taskContext.recentMessages ?? [])]);
  const native = messages.filter(message => message.role !== "system");
  const latestIndex = native.lastIndexOf(latest);
  // current already contains the complete user message. Sending it again in
  // recent duplicates long input without adding history or a valid offer index.
  const timedRecent = recent.filter(item => item.index !== latestIndex).map(item => {
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
        `你是伴星的回合解释器，只输出 JSON：{"intent":"conversation|question|task|task_control|mixed","toolUse":"none|read|act|uncertain","subjects":[],"goalRelation":"unrelated|new|continue|revise|control|discuss|unclear","candidateOperations":[],"ambiguities":[],"voiceStyle":{"decision":"none|apply|clarify","instruction":null,"persistentPreference":{"action":"keep|set|clear","dialect":null}},"executionConstraints":{"timeBasedWakeups":"forbid|unspecified","sourceQuote":null},"pendingOfferIndexes":[]}。`,
        "current 是用户这一句；recent 只帮助理解指代，不继承旧任务。intent：闲聊/情绪/称呼=conversation；知识、解释、查资料、核对记录=question；保存/修改/生成/安排/导航=task；控制后台目标=task_control；两者都有=mixed。",
        "toolUse：直接回答或闲聊=none；需要看用户自己的笔记、卡片、来源、历史、记忆、统计、到期、任务、提醒、页面、图片，或联网查资料、实际计算=read；需要写入、修改、删除、执行、导航=act；缺少对象/范围/指代不明/无法执行=uncertain。",
        "需要工具的例子：查看或读取资料、搜笔记/卡片、问学习进度/到期/任务/提醒/最近活动、看图、联网核实、把数值代入计算、保存或修改记忆/笔记/偏好/人格/提醒/共享/学习任务、调整笔记格式。不需要工具：普通知识解释、闲聊、情绪、角色口味、自我介绍、操作方法、直接写故事/诗/文案草稿。",
        "称呼伴星、随口招呼、情绪表达和角色口味是对话内容；话题名词或昵称没有对应 object 不构成歧义。",
        "用户明确要求调整/整理/规范/优化当前笔记格式/排版，或插入/删除/替换正文、转表格/流程图时，是 task/act，候选 companion_edit_note；‘改一下’与‘调整一下’含义相同；明确说全文/整篇且没有局部限制时范围是整篇，无需选区或光标；只问有哪些问题、怎么调整、先别改时按 question/read；不要求用户额外说保存。",
        "用户要求生成速看、脑图、互动演示、拓展稿或学习卡时是 task/act、goalRelation=new，用 agent_start_goal；不要求用户再说‘保存’或指定保存位置。历史助手说过能力没接上、不能保存，不是当前能力事实。",
        "用户明确禁止搜索或读取资料时，仍独立创建新笔记，不发起资料读取或添加库内链接。",
        "candidateOperations 只填 capabilities 里的 name，是候选不是授权；subjects 讨论对象只在 objects 有真实对应时给 objectIndex，否则只写 description；只有指向 objects 里真实后台目标时才加 goalObjectIndex（0 起算），否则省略；goalRelation 只对真实 agent_run 用 continue/revise/control/discuss，其他用 unrelated；没有对象、代词未消解或修改范围不明放入 ambiguities。",
        `voiceStyle：当前句明确要求改变口音/方言/语速/音色/场景语气→apply 并给 ≤50 字 instruction；结合完整语义和近期对话理解省略与指代，不能靠关键词或固定词序猜。只有用户明确说“以后/今后/之后都默认/一直用某具体方言”这类持续要求时才 set 并填规范名称；说过“以后默认河南话，但这句用四川话”要 set 河南话、本轮 apply 四川话；明确要求以后普通话或停止固定方言→clear、dialect=null；普通轮次和临时切换→none/keep；单轮点名其他地区不改默认；要求讲方言但没说哪种→clarify。只提到地区、讲自己想家、询问方言词义、讲故事/笑话都不等于切换声音。支持方言：${QWEN_TTS_SUPPORTED_DIALECTS.join("、")}。本轮明确要求普通话时 apply ${QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION}。`,
        "executionConstraints 只记录 current 明确“只按事件触发/不要定时”的要求→forbid，并在 sourceQuote 逐字引用 current 里的原话；否则 unspecified/sourceQuote=null。历史里的单轮限制不继承。",
        "pendingOfferIndexes：recent 里某条 assistant 结尾还挂着用户这句没接的邀请/提议/等待，逐条给出 index；用户已接、已照做或已说不用回应就不放。只引用 recent 给过的 index，没有就返回空数组。",
        "objects 和 capabilities 是宿主数据，不发明身份或工具名；capabilities 只给 name 和 label。",
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify({ current, recent: timedRecent,
      conversationClock: taskContext.conversationClock ?? null, objects: taskContext.objects ?? [],
      capabilities: (taskContext.capabilities ?? []).map(companionIntentCapabilityEntry) }) },
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
  const current = typeof latest?.content === "string" ? latest.content : (latest?.content ?? [])
    .filter(part => part.type === "text").map(part => part.text).join(" ");
  const binding = { requestHash: taskContext.requestHash ?? sha256Utf8V1(current),
    objects: taskContext.objects ?? [], capabilities: taskContext.capabilities ?? [],
    offerCandidates: companionOfferCandidates(messages), currentUserText: current };
  const unknown = () => resolveAgentTurnInterpretation(null, binding);
  const requestMessages = buildCompanionTurnInterpretationMessages(messages, taskContext);
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
  /** 分类器对冲：默认关（测试契约不变），生产由 compose 的 COMPANION_TOOL_INTENT_HEDGE_MS 开启。 */
  const hedgeDelayMs = resolveClassifierHedgeDelayMs();
  let hedged = false;
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
      // 对冲：同一路由、逐字相同的请求再发一份，先回来的那份留下、另一份 abort。
      // 分类器 temperature=0 且输出是受约束 JSON，副本不改变语义（零质量风险）；
      // 实测副本之间延迟几乎不相关（r=-0.12），所以这是纯尾部收益，不碰主步与工具。
      const call = await runHedgedCall(
        (signal) => provider.chatCompletion(input.messages, {
          // 天花板只认档案声明：这一发的上限由 provider 按模型档案给，
          // handler 报的数字早就不是这一发的真实上界了。
          // 关思考仍由 disableThinking 决定——它是档位判据，不是砍话的那把刀。
          temperature: 0,
          responseFormat: "json_object",
          disableThinking: true,
        }, signal),
        { signal: env.signal, hedgeDelayMs, onHedge: () => { hedged = true; } },
      );
      hedged ||= call.hedged;
      const answer = call.value;
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
    ...(hedged ? { hedged: true } : {}),
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
