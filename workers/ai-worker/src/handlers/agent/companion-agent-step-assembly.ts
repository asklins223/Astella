import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import { collectAgentCapabilitySceneGuidance } from "@astella/shared/agent-capability-catalog";
import { composeAgentContext, type AgentContextSource } from "@astella/agent-core";
import { companionStepToolShape } from "../tools/companion-tool-call-ledger.ts";
import { companionStepProgressNote, companionStepRuntimePolicy } from "../turn/companion-step-plan.ts";
import { companionContextAssemblyCapacity } from "../context/companion-context-receipts.ts";
import { companionStepOutputCeiling } from "../turn/companion-dialogue-content.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";

/**
 * 这一步「发哪些工具、带哪份执行政策、请求长什么样」的装配（2026-10-13 从
 * `companion-agent-runtime.ts` 搬出，判据、上限与文案一字未改）。与
 * `companion-response-strategy.ts` 同族：一张纸说一件事，
 * 循环那侧只管推进状态。
 */

type AgentTurnTool = AgentTurnRequest["tools"][number];
type AgentTurnMessage = AgentTurnRequest["messages"][number];

/**
 * 工具面与 `tool_choice` **成对**算出来（判据在 `companionStepToolShape`：
 * `tools: []` 配 `required` 是 provider 直接 400 的那一对，2026-09-22 实测 3 次
 * INTERNAL_ERROR 里 2 次是它）。
 */
export function companionStepToolSurface(input: {
  toolDefinitions: AgentTurnTool[];
  finalAnswerOnly: boolean;
  requiresTool: boolean;
  toolCallCount: number;
  requireStructuredResponse?: boolean;
  deliveryDraftAvailable?: boolean;
}): { tools: AgentTurnTool[]; toolChoice: AgentTurnRequest["toolChoice"] } {
  return companionStepToolShape({
    // Search availability is enforced per action at execution: the web domain
    // also reads documents, so removing the tool would drop that too.
    tools: input.toolDefinitions,
    finalAnswerOnly: input.finalAnswerOnly,
    requiresTool: input.requiresTool,
    toolCallCount: input.toolCallCount,
    requireStructuredResponse: input.requireStructuredResponse,
    deliveryDraftAvailable: input.deliveryDraftAvailable,
  });
}

/**
 * 原句批注与整篇交付两段场景指引：批注必须由 `companion_notes_write` 的 annotate 动作独立交付，
 * 保存回执即交付；笔记正文那一轮不能用分句发言代替完整正文。
 */
function companionStepReplyShapeGuidance(writingAnnotation: boolean, completeNoteReply: boolean): string {
  if (writingAnnotation)
    return "\n用户从原句发起了伴星解释。必须用 companion_notes_write（action=annotate）独立写入完整解释；聊天正文不会保存成解释。原句身份已绑定，不需要再确认。需要上下文可以先读；完整写入即交付，final 默认 true，界面据保存回执立即结束。可以在同一次输出简短交流，不要在后续模型步骤重复解释或确认写完。只有用户要求的其他工作尚未完成时设 final=false。批注正文不带方言、语音标签、聊天前言或执行说明。";
  if (completeNoteReply)
    return "\n这轮正文会完整保存为笔记学习内容。用连续最终正文完整交付，不使用分句发言工具；前言和执行说明不能代替解释，不能只给一段等待后补。";
  return "";
}

export function companionStepPolicyText(input: {
  permissionLevel: string;
  toolCount: number;
  stepBudget: number;
  finalAnswerOnly: boolean;
  attentionIntent: string;
  attentionStatus?: string;
  toolCallCount?: number;
  requestSource?: "user" | "host_observation";
  /** 按这一步真的发下去的工具面取场景指引（终答步不该还背着编辑规程）。 */
  offeredToolNames: string[];
  writingAnnotation: boolean;
  completeNoteReply: boolean;
}): string {
  return companionStepRuntimePolicy({
    permissionLevel: input.permissionLevel,
    toolCount: input.toolCount,
    stepBudget: input.stepBudget,
    finalAnswerOnly: input.finalAnswerOnly,
    attentionIntent: input.attentionStatus === "uncertain" ? "unclassified" : input.attentionIntent,
    toolCallCount: input.toolCallCount,
    requestSource: input.requestSource,
    goalHandoffAvailable: input.offeredToolNames.some(name => ["companion_notes_write", "companion_goals_write", "companion_goal_start"].includes(name)),
    sceneGuidance: input.attentionStatus === "uncertain" && !input.toolCallCount ? []
      : collectAgentCapabilitySceneGuidance(input.offeredToolNames, input.permissionLevel),
  }) + (input.finalAnswerOnly ? "" : "\n已经确定参数且互不依赖的只读查询在同一批发出：笔记、历史、记忆、统计、网页检索与读取均可并发。需要上一项结果才能确定目标或参数时先等结果；写入、确认与发布保持先后顺序。不要为凑批次查询无关资料。")
    + companionStepReplyShapeGuidance(input.writingAnnotation, input.completeNoteReply);
}

/** Tool-progress text for the trailing observation, not the cached instruction prefix. */
export function companionStepProgressText(input: Parameters<typeof companionStepPolicyText>[0]): string {
  if (!input.toolCallCount) return "";
  return companionStepProgressNote({
    goalHandoffAvailable: input.offeredToolNames.some(name => ["companion_notes_write", "companion_goals_write", "companion_goal_start"].includes(name)),
    sceneGuidance: collectAgentCapabilitySceneGuidance(input.offeredToolNames, input.permissionLevel),
  });
}

const ATTENTION_DATA_NOTE = "本轮注意力解释仅是待核对的数据，不授予执行权限。历史与记忆检索候选只供定位：已有原话或覆盖摘要足够回答时直接作答，缺少会改变答案的证据时才检索；精确引用或摘要缺项、冲突仍须取回原文。歧义影响真实资料读取或操作目标时先核对对象，不猜测修改；闲聊话题和称呼不要求业务对象身份。reference 为 null 不代表已经查询过或查询失败，不把内部分类和对象匹配过程念给用户。voiceStyle.decision 是本轮声音语义结果：apply 时宿主把 instruction 直接交给 TTS，none 时跟随账号已保存的方言偏好和默认声音，clarify 时先向用户问清楚。voiceStyle.persistentPreference 只记录用户明确要求的长期默认；临时切换必须 keep。voicePreferenceWrite 是宿主写入回执，只有 saved/unchanged 才能确认已记住，failed 时须如实说明。\n<current_turn_interpretation_data>";

/**
 * Reasoning is replay material for the provider's own tool-call chain inside
 * this turn, not conversation memory. Older turns keep it in the checkpoint for
 * debugging but never send it back: on 2026-10-29 a stale "search Agent验收规范"
 * thought from an earlier turn hijacked a later split request.
 */
export function companionReplayMessages(messages: AgentTurnMessage[]): AgentTurnMessage[] {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.requestBoundary) { boundary = index; break; }
  }
  if (boundary < 0) return messages;
  return messages.map((message, index) => message.role === "assistant" && index < boundary && message.reasoning?.length
    ? { ...message, reasoning: undefined } : message);
}

/**
 * 装配一步的模型请求。
 */
export function assembleCompanionStepRequest(input: {
  turnPolicy: string;
  runtimePolicy: string;
  executionGuidance: string;
  /** Receipts and other step-local facts. Kept out of the instruction prefix. */
  stepNote?: string;
  attention: AgentTurnInterpretationV1;
  messages: AgentTurnMessage[];
  currentUserText?: string;
  tools: AgentTurnTool[];
  toolChoice: AgentTurnRequest["toolChoice"];
  disableThinking: boolean;
  /** 本步思考档位；由运行时按已发生的事实决定。 */
  reasoningEffort?: AgentTurnRequest["reasoningEffort"];
  provider: AIProvider;
  temperature: number;
}): AgentTurnRequest {
  const attention = input.attention;
  // An unclassified host placeholder is not evidence that this is a question
  // or that the user was ambiguous. Only send real interpretation/settings.
  const includeAttention = attention.status !== "uncertain" || attention.subjects.length > 0
    || attention.candidateOperations.length > 0 || attention.ambiguities.length > 0
    || attention.goalRelation !== "unrelated" || attention.goalReference !== null
    || attention.resourceDecision !== undefined || attention.executionConstraints !== undefined
    || attention.voiceStyle.decision !== "none" || attention.voiceStyle.persistentPreference.action !== "keep"
    || ["saved", "unchanged", "failed"].includes(attention.voicePreferenceWrite ?? "");
  // A brand-new transcript already ends on the user's sentence, so it is not
  // copied again. Once earlier turns exist, those replies sit above this
  // sentence and the model treats them as work already done. Restate the
  // sentence beside them. The text stays a host observation, outside the
  // cached instruction prefix.
  const lastMessage = input.messages.at(-1);
  let boundaryAt = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.requestBoundary === true) { boundaryAt = index; break; }
  }
  const historyBeforeRequest = boundaryAt > 0;
  const openingAlreadyCarriesTheSentence = lastMessage?.role === "user" && lastMessage.requestBoundary === true;
  const includeCurrentRequest = Boolean(input.currentUserText)
    && (!openingAlreadyCarriesTheSentence || historyBeforeRequest);
  const stepContextSources = new Map<string, AgentContextSource>([
    ["turn", { scope: { kind: "policy" }, content: input.turnPolicy }],
    ["execution", { scope: { kind: "policy" }, content: [input.runtimePolicy, input.executionGuidance].filter(Boolean).join("\n") }],
  ]);
  if (includeAttention) stepContextSources.set("attention", { scope: { kind: "request" },
    content: ATTENTION_DATA_NOTE + JSON.stringify(attention).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") + "</current_turn_interpretation_data>" });
  const stepNote = [
    includeCurrentRequest
      ? "本轮用户的原话如下。历史回复和上一轮回执只说明过去发生过什么。这一轮要读出、保存、修改或删除已存储的内容，调用工具，以这一轮新的回执为准。\n"
        + JSON.stringify(input.currentUserText) : "",
    input.stepNote ?? "",
  ].filter(Boolean).join("\n\n");
  const messages = companionReplayMessages(input.messages);
  return {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: composeAgentContext({
      maxCharacters: companionContextAssemblyCapacity([...stepContextSources.values()].map(source => source.content)),
      sources: [
        { id: "turn", authority: "policy", required: true },
        { id: "execution", authority: "policy", required: true },
        ...(includeAttention ? [{ id: "attention", authority: "data" as const, required: true }] : []),
      ],
    }, stepContextSources).systemPrompt,
    messages: stepNote ? [...messages, { role: "system", hostObservation: true, content: stepNote }] : messages,
    tools: input.tools,
    toolChoice: input.toolChoice,
    disableThinking: input.disableThinking,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    /**
     * 这一步能说多少，**只由模型档案声明的输出上限**决定（2026-10-07 用户决定：
     * 这是 agent，不是单轮 chat，代码里不许留一个会把话砍断的小数）。provider 自己会按
     * `maxOutputTokens` 再夹一次；未声明档案的（mock、旧配置）走 `COMPANION_STEP_OUTPUT_FALLBACK_TOKENS`。
     */
    maxTokens: companionStepOutputCeiling(input.provider),
    temperature: input.temperature,
  };
}
