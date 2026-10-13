/**
 * 投机的第一步（2026-10-07；2026-10-13 补第二形状）。
 *
 * ## 为什么
 *
 * 伴星的一轮是**两次串行模型往返**：先分类器（判本轮意图：要不要工具、要不要开思考），
 * 再让她开口。实测分类器 1.9–2.4s，而她开口那一步的首字也要 1.5–3.4s——用户看到的
 * "等 3 秒还没动静"里，第一半就是那次**不产出任何可见内容**的往返。
 *
 * ## 怎么做
 *
 * 不猜、不跳步：分类器照跑，服务端的判定权一分不让；同时在它跑的时候，按两个
 * **假设**各把第一步发出去，分类落地后二选一：
 * - 闲聊假设（`buildCasualFirstStepRequest`）→ 解释为空时留下（`shouldKeepSpeculativeFirstStep`）；
 * - 提问假设（`buildQuestionFirstStepRequest`，2026-10-13）→ 解释是"干净的问题"时留下
 *   （`shouldKeepSpeculativeQuestionStep`）。此前问题轮没有对应形状，那条分类往返白等。
 * 两个都不成立 → 两版一起作废（abort），回到原路径，等待时间与从前一致。
 *
 * 流式生成在分类期间先攒住文字；releaseGate 同意后才交付，作废时没有可见文字。
 * provider 先结束也仍等待分类，生成与交付使用同一份结果和同一个取消预算。
 *
 * ## 为什么保留条件比"她是闲聊"更严
 *
 * 投机的提示词里**没有注意力块**（那时还没有真实的解释）。只有当真实的解释什么都没
 * 带来（无待核对指称、无歧义、无工具意图）时，缺那一块才等价于没缺——所以保留条件
 * 逐条对应"解释带来了什么"，缺一不可；提问版的形状还必须与真实第一步逐字段同形
 * （完整工具面、开思考、知识核对指引、温度 0.3），否则回答质量会分叉。
 */
import { isCompanionAutonomousTool, AgentRole, type AgentTurnRequest } from "@astella/shared";
import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import { composeAgentContext } from "@astella/agent-core";
import { collectAgentCapabilitySceneGuidance } from "@astella/shared/agent-capability-catalog";
import { companionContextAssemblyCapacity } from "./companion-context-receipts.ts";
import { companionStepRuntimePolicy } from "./companion-step-plan.ts";
import { companionResponseStrategy } from "./companion-response-strategy.ts";

/**
 * "闲聊假设"的第一步：仅提供自身记录工具、不开思考、提示词里**没有注意力块**（那时还没有
 * 真实的解释）。
 *
 * 只**构造**请求，不自己发——发出去那一下仍走循环里那条流式路径
 * （`runStreamingAgentStep` + `releaseGate`），这样放行闸、审计哈希、坍缩闸的
 * `stepEmitted` 语义全都与真实第一步一致，不存在第二套交付实现。
 */
export function buildCasualFirstStepRequest(args: {
  /** 本轮的 turn 政策块（真实第一步用的那一份，原样带上）。 */
  turnPolicy: string;
  permissionLevel: string;
  stepBudget: number;
  messages: AgentTurnRequest["messages"];
  maxTokens: number;
  tools?: AgentTurnRequest["tools"];
}): AgentTurnRequest {
  // Speculation only proposes: runtime executes after release and checkpointing.
  const tools = args.tools?.filter(tool => isCompanionAutonomousTool(tool.name)) ?? [];
  const contextSources = new Map([
      ["turn", { scope: { kind: "policy" as const }, content: args.turnPolicy }],
      ["execution", { scope: { kind: "policy" as const }, content: companionStepRuntimePolicy({
        permissionLevel: args.permissionLevel,
        toolCount: tools.length,
        stepBudget: args.stepBudget,
        finalAnswerOnly: false,
        attentionIntent: "conversation",
      }) }],
    ]);
  return {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: composeAgentContext({ maxCharacters: companionContextAssemblyCapacity([...contextSources.values()].map(source => source.content)), sources: [
      { id: "turn", authority: "policy", required: true },
      { id: "execution", authority: "policy", required: true },
    ] }, contextSources).systemPrompt,
    // 浅拷贝：真实循环随后会往 messages 里推工具消息，别写进这次请求。
    messages: [...args.messages],
    tools,
    disableThinking: true,
    maxTokens: args.maxTokens,
    temperature: companionResponseStrategy({ intent: "conversation", toolUse: "none" }).temperature,
  };
}

/**
 * "提问假设"的第一步（2026-10-13）：问题轮的首字 = 分类器 + 她的第一步**两次串行往返**，
 * 实测分类器 1.4–3.6s（真实桌面，ai_audit_log）。闲聊那条投机只服务 conversation，
 * 问题/混合轮依旧白等一次分类往返——这一版把**提问形状**也提前发出去。
 *
 * 形状必须与真实第一步**逐字段同形**（否则回答质量会分叉）：
 * 同一个 turn 政策块、`attentionIntent: "question"` 的运行时策略 + 知识核对指引、
 * 完整工具面（不摘写类）、`disableThinking: false`、温度 0.3、`tool_choice: auto`。
 * 唯一的差别是**没有注意力块**——那要等分类器；所以保留条件（见
 * `shouldKeepSpeculativeQuestionStep`）只收"解释什么都没带来"的干净问题。
 */
export function buildQuestionFirstStepRequest(args: {
  /** 本轮的 turn 政策块（真实第一步用的那一份，原样带上）。 */
  turnPolicy: string;
  permissionLevel: string;
  stepBudget: number;
  messages: AgentTurnRequest["messages"];
  maxTokens: number;
  /** 与真实第一步同一份工具面（含写类；调用方已按 web 搜索配额过滤）。 */
  tools?: AgentTurnRequest["tools"];
}): AgentTurnRequest {
  const tools = args.tools ?? [];
  const strategy = companionResponseStrategy({ intent: "question", toolUse: "none" });
  const contextSources = new Map([
      ["turn", { scope: { kind: "policy" as const }, content: args.turnPolicy }],
      ["execution", { scope: { kind: "policy" as const }, content: [
        companionStepRuntimePolicy({
          permissionLevel: args.permissionLevel,
          toolCount: tools.length,
          stepBudget: args.stepBudget,
          finalAnswerOnly: false,
          attentionIntent: "question",
          sceneGuidance: collectAgentCapabilitySceneGuidance(tools.map(tool => tool.name), args.permissionLevel),
        }),
        strategy.guidance,
      ].filter(Boolean).join("\n") }],
    ]);
  return {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: composeAgentContext({ maxCharacters: companionContextAssemblyCapacity([...contextSources.values()].map(source => source.content)), sources: [
      { id: "turn", authority: "policy", required: true },
      { id: "execution", authority: "policy", required: true },
    ] }, contextSources).systemPrompt,
    // 浅拷贝：真实循环随后会往 messages 里推工具消息，别写进这次请求。
    messages: [...args.messages],
    tools,
    toolChoice: "auto",
    disableThinking: false,
    maxTokens: args.maxTokens,
    temperature: strategy.temperature,
  };
}

/**
 * 这版投机结果能不能留下：解释必须**什么都没带来**。
 *
 * 只要它给出待核对的指称（subjects）、未解的歧义（ambiguities）、任何工具意图
 * （read/act/uncertain），或**她上一条里还挂着用户没接的收尾**（pendingOfferIndexes），
 * 真实的第一次请求就该看到那份数据或那次改写——那种轮次一律作废重跑。
 */
export function shouldKeepSpeculativeFirstStep(attention: Pick<AgentTurnInterpretationV1, "intent" | "toolUse"> & {
  readonly subjects?: readonly unknown[];
  readonly ambiguities?: readonly unknown[];
  readonly pendingOfferIndexes?: readonly number[];
  readonly voiceStyle?: AgentTurnInterpretationV1["voiceStyle"];
}): boolean {
  return attention.intent === "conversation"
    && attention.toolUse === "none"
    && (attention.subjects?.length ?? 0) === 0
    && (attention.ambiguities?.length ?? 0) === 0
    // An ambiguous dialect request needs the clarified interpretation in the real prompt.
    && attention.voiceStyle?.decision !== "clarify"
    // 投机的请求是按未改写的历史发出去的；留着它就等于绕过了收尾降级。
    && (attention.pendingOfferIndexes?.length ?? 0) === 0;
}

/**
 * 提问版投机的保留条件：比闲聊版更严一档，缺一不可。
 *
 * - `question` 且 `toolUse: "none"`：read/act/uncertain 都说明真实请求该看到注意力块；
 * - `subjects`/`ambiguities`/`candidateOperations` 全空：解释没有带来任何对象或动作线索；
 * - `goalRelation === "unrelated"`：本轮与后台目标无关。有关联时真实提示词里带着目标引用，
 *   少那一块可能漏掉"接着那个目标"的语义——宁可作废；
 * - 收尾与方言澄清同闲聊版：那两类都要真实解释在场。
 */
export function shouldKeepSpeculativeQuestionStep(attention: Pick<AgentTurnInterpretationV1, "intent" | "toolUse"> & {
  readonly subjects?: readonly unknown[];
  readonly ambiguities?: readonly unknown[];
  readonly candidateOperations?: readonly string[];
  readonly pendingOfferIndexes?: readonly number[];
  readonly goalRelation?: AgentTurnInterpretationV1["goalRelation"];
  readonly voiceStyle?: AgentTurnInterpretationV1["voiceStyle"];
}): boolean {
  return attention.intent === "question"
    && attention.toolUse === "none"
    && (attention.subjects?.length ?? 0) === 0
    && (attention.ambiguities?.length ?? 0) === 0
    && (attention.candidateOperations?.length ?? 0) === 0
    && attention.goalRelation === "unrelated"
    && attention.voiceStyle?.decision !== "clarify"
    && (attention.pendingOfferIndexes?.length ?? 0) === 0;
}
