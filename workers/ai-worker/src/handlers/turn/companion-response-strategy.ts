type CompanionResponseAttention = {
  intent?: string;
  toolUse?: string;
} | null | undefined;

/** A generation instruction, not a claim that facts have been independently verified. */
export const COMPANION_KNOWLEDGE_REVIEW_V1 = [
  "围绕用户当前问题先给直接结论，再给最短的充分论证与必要条件；用户要求详细时再展开。满足问题即可收住，未要求概括更一般的条件时，不主动扩大命题或补写旁枝。",
  "组织正文前在内部核对完整推理链、数量、方向和量纲，让公式、代入和结论一致；需要数值运算时使用可用计算工具并依据真实结果。自己的另一段推导不算独立验证。",
  "区分题目给定事实、说明用的假设、可能解释与已经取得的证据。证据不足就说明边界，不能把可能性写成已经证实的因果，不能把局部条件下的结论扩成无条件规律。人格只影响表达，不改变事实与推理。",
].join("\n");

/** Keep the claim's scope tied to the question; personality is expression. */
export const COMPANION_KNOWLEDGE_REVIEW_V2 = [
  "先回答用户实际提出的各个问题，给出足以支持结论的推理和适用条件即可结束。用户没有问的一般化定理、原因清单和旁枝不补写；每个附加判断也承担同样的举证责任。",
  "组织正文前核对推理链、数量、方向和量纲，让公式、代入和结论一致；需要数值运算时使用可用计算工具并依据真实结果。自己的另一段推导不算独立验证。",
  "充分条件只说明在该条件下成立；必要性或等价性需要另证，不能把一个成立的例子扩大为唯一情形。一般结论先尝试反例；证明不了的方向不作断言。",
  "给定事实、假设与可能解释分开表达。未测量的变量保持未知，信息不足可以直接说明，不自行断言它们已经变化、产生多大效果或必然回到某状态。人格只影响措辞，不改变事实、证据强度和推理。",
].join("\n");

/** Intent is resolved once for the turn. A tool-free final step must not turn
 * a knowledge answer into high-variance chat merely because tools were withheld. */
export function companionResponseStrategy(attention: CompanionResponseAttention): {
  mode: "casual" | "knowledge" | "task";
  temperature: number;
  guidance: string;
} {
  if (attention?.intent === "conversation" && attention.toolUse === "none") {
    return { mode: "casual", temperature: 0.4, guidance: "" };
  }
  if (attention?.intent === "task" || attention?.intent === "task_control"
      || attention?.intent === "conversation") {
    // Intent describes what the user wants done, not whether the result contains
    // factual claims: drafting a lesson or editing a note can include a derivation.
    return { mode: "task", temperature: 0.4, guidance: COMPANION_KNOWLEDGE_REVIEW_V2 };
  }
  // Questions, mixed explanation/task turns and failed interpretation use the
  // stable explanation path, preserving the existing thinking decision.
  return { mode: "knowledge", temperature: 0.3, guidance: COMPANION_KNOWLEDGE_REVIEW_V2 };
}

/** Offline quality-comparison experiment only; production does not run a reviewer. */
export function isCompanionExplanation(attention: CompanionResponseAttention,
  userText: string, offeredTools: number): boolean {
  return offeredTools === 0 && (attention?.intent === "question" || attention?.intent === "mixed")
    && /解释|讲讲|详细|为什么|原理|推导|讲清|理解|\b(?:explain|why|derive|detailed)\b/iu.test(userText);
}
