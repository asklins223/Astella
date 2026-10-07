/**
 * 投机的第一步（2026-10-07）：分类器还在路上时，先按"闲聊假设"把第一步发出去。
 *
 * ## 为什么
 *
 * 伴星的一轮是**两次串行模型往返**：先分类器（判本轮意图：要不要工具、要不要开思考），
 * 再让她开口。实测分类器 1.9–2.4s，而她开口那一步的首字也要 1.5–3.4s——用户看到的
 * "等 3 秒还没动静"里，第一半就是那次**不产出任何可见内容**的往返。
 *
 * ## 怎么做
 *
 * 不猜、不跳步：分类器照跑，服务端的判定权一分不让；同时在它跑的时候，按"本轮是闲聊"
 * 这个**假设**把第一步发出去。分类器落地后：
 * - 同意（本轮解释确实为空，见 `shouldKeepSpeculativeFirstStep`）→ 这版就是第一步，
 *   用户少等整整一次往返；
 * - 不同意 → 整版作废（abort），回到原路径，等待时间与从前一致。
 *
 * 流式生成在分类期间先攒住文字；releaseGate 同意后才交付，作废时没有可见文字。
 * provider 先结束也仍等待分类，生成与交付使用同一份结果和同一个取消预算。
 *
 * ## 为什么保留条件比"她是闲聊"更严
 *
 * 投机的提示词里**没有注意力块**（那时还没有真实的解释）。只有当真实的解释什么都没
 * 带来（无待核对指称、无歧义、无工具意图）时，缺那一块才等价于没缺——所以
 * `shouldKeepSpeculativeFirstStep` 四条件缺一不可。
 */
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import { composeAgentContext } from "@astella/agent-core";
import { COMPANION_CONTEXT_SYSTEM_MAX_CHARACTERS } from "./companion-context-receipts.ts";
import { companionStepRuntimePolicy } from "./companion-step-plan.ts";

/**
 * "闲聊假设"的第一步：不给工具、不开思考、提示词里**没有注意力块**（那时还没有
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
}): AgentTurnRequest {
  return {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: composeAgentContext({ maxCharacters: COMPANION_CONTEXT_SYSTEM_MAX_CHARACTERS, sources: [
      { id: "turn", authority: "policy", required: true },
      { id: "execution", authority: "policy", required: true },
    ] }, new Map([
      ["turn", { scope: { kind: "policy" as const }, content: args.turnPolicy }],
      ["execution", { scope: { kind: "policy" as const }, content: companionStepRuntimePolicy({
        permissionLevel: args.permissionLevel,
        toolCount: 0,
        stepBudget: args.stepBudget,
        finalAnswerOnly: false,
        attentionIntent: "conversation",
      }) }],
    ])).systemPrompt,
    // 浅拷贝：真实循环随后会往 messages 里推工具消息，别写进这次请求。
    messages: [...args.messages],
    tools: [],
    disableThinking: true,
    maxTokens: args.maxTokens,
    temperature: 0.9,
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
}): boolean {
  return attention.intent === "conversation"
    && attention.toolUse === "none"
    && (attention.subjects?.length ?? 0) === 0
    && (attention.ambiguities?.length ?? 0) === 0
    // 投机的请求是按未改写的历史发出去的；留着它就等于绕过了收尾降级。
    && (attention.pendingOfferIndexes?.length ?? 0) === 0;
}
