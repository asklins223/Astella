import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import type { CompanionEntryMode } from "./companion-entry-mode.ts";

export type CompanionTurnWorkload = "casual" | "adaptive";

// A deliberately small allowlist of complete conversational clauses. Unknown
// speech retains the model's reasoning; a task containing a greeting cannot
// enter this path. This changes inference cost, never permissions or tools.
const CASUAL_CLAUSES = [
  /^(?:你好|您好|嗨|嘿|在吗|你在吗|在不在|早|早安|早上好|中午好|下午好|晚上好|晚安|再见|拜拜|谢谢(?:你)?|多谢|不客气)[呀啊呢哦啦哟哈~～]*$/u,
  /^(?:哈){2,12}$/u,
  /^(?:我)?(?:今天|现在|最近)?(?:感觉|觉得)?(?:有点|有些|很|好|太|特别)?(?:累|疲惫|困|开心|高兴|难过|紧张|焦虑|无聊)(?:了|啊|呀|呢|啦)?$/u,
  /^(?:随便聊聊|聊聊天|陪我聊聊|说点轻松的)(?:吧|呀|啊)?$/u,
  /^(?:hi|hey|hello|good morning|good afternoon|good evening|good night|thanks|thank you|bye|goodbye)$/iu,
];

// Short personal updates are broader than greeting phrases, but still must
// contain no question, requested operation, technical notation or help request.
// A negative request to leave the person alone remains part of the full prompt;
// it is only removed from these inference-cost features.
function isPersonalShare(text: string): boolean {
  if (!/^(?:我(?:今天|最近|刚|现在|终于|有点|很|好|就想)|(?:今天|最近)(?:我|终于|有点|脑子|天气)|刚(?:刚)?从)/u.test(text)
    || !/^[\p{Script=Han}\s，。！、；：“”‘’（）…~～]+$/u.test(text)) return false;
  const features = text.replace(/(?:不用|不要|别)(?:再)?(?:问我问题|安排学习)[^，。！、；\n]*/gu, "");
  return !/解释|说明|证明|推导|分析|比较|总结|概括|解决|排查|怎么|如何|为什么|是什么|哪个|哪里|哪些|多少|问题|[题式]|不懂|不明白|不理解|搞不懂|给我|帮我|帮忙|请|麻烦|记住|记一下|提醒|通知|安排|叫我|保存|新建|创建|写|改|编辑|删除|读|查|搜|打开|跳转|计算|算一下|分条|分成|消息|笔记|手记|日记|记事|记忆|任务|计划|继续|接着|执行|照做|刚才/u.test(features);
}

export function resolveCompanionTurnWorkload(input: {
  mode: CompanionEntryMode;
  userText: string;
  attention: Pick<AgentTurnInterpretationV1, "status" | "intent" | "toolUse" | "candidateOperations">;
  requiresGrounding: boolean;
}): CompanionTurnWorkload {
  if (input.mode === "direct_thinking" || input.requiresGrounding
    || input.attention.candidateOperations.length > 0
    || ["read", "act"].includes(input.attention.toolUse)
    || (input.attention.status === "interpreted" && input.attention.intent !== "conversation")) return "adaptive";
  const text = input.userText.trim();
  if (!text || text.length > 120) return "adaptive";
  const clauses = text.split(/[，。！？!?；;,\n]+/u).map(clause => clause.trim()).filter(Boolean);
  return (clauses.length > 0 && clauses.length <= 4
    && clauses.every(clause => CASUAL_CLAUSES.some(pattern => pattern.test(clause)))) || isPersonalShare(text) ? "casual" : "adaptive";
}

export function companionStepReasoning(input: {
  mode: CompanionEntryMode; workload: CompanionTurnWorkload; deepened: boolean;
  repairing: boolean; readOnlyRequiredStep: boolean; toolCallCount: number;
}): "none" | "medium" | "high" | undefined {
  if (input.repairing || input.deepened || input.mode === "direct_thinking") return "high";
  if (input.readOnlyRequiredStep) return "none";
  if (input.toolCallCount > 0) return "medium";
  return input.workload === "casual" ? "none" : undefined;
}

export const COMPANION_CASUAL_TURN_GUIDANCE = "这是简短日常交流，直接自然接话，按当前人格表达，不附知识检查清单、任务前言或执行汇报。不要为了找事做而读取或改动资料。若实际需要多步推理、核对信息或操作，仍可使用本轮工具；操作完成必须以真实回执为准。";
