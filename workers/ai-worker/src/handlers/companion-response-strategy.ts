import type { CompanionTurnThinkingInput } from "./companion-turn-thinking.ts";

/** A generation instruction, not a claim that facts have been independently verified. */
export const COMPANION_KNOWLEDGE_REVIEW_V1 = [
  "解释知识、概念或原理时，先在内部核对关键关系，再组织正文：因果是否成立、方向是否颠倒、符号和单位是否对应、结论在什么条件下适用。不要展示这份检查过程。",
  "数学推导逐步保持等式两边含义一致，检查事件、下标、分子分母和适用条件；通式、展开式、代入式与例子必须相互一致。需要实际计算时使用本轮提供的计算工具核对，不能用自己生成的另一段推导冒充验证；没有工具时不要声称已经计算核验。",
  "需要计算工具时，先确定表达式并调用，取得结果再组织完整讲解，不在工具调用前先心算和预写整篇答案。概率结果与补概率、百分比和‘几成’必须同口径；反事件概率是1减去当前同一条件下的概率，不能拿另一个条件的似然代替。使用条件概率比值时，核对每个条件事件的概率都大于0；概率为0不代表集合为空，概率为1或几乎处处成立也不能推出严格的集合包含关系。",
  "有当前材料时，以材料和真实读取结果核对；用户问题中的断言也可能有误，不能直接当作结论。没有可靠依据的细节不要补猜，必要时明确条件或不确定性；自己的另一种说法不算独立证据。",
  "还要检查补充说明中的绝对化：近似关系不能写成无条件的精确规律。使用正比、等于、总是、只能等判断时，确认适用条件；若只是常见条件下的近似，就把这层条件一起讲清，不把类比或直觉升级成定律。",
  "详细说明先围绕用户提出的各点把概念、条件和推理讲清。没有当前依据的具体参数、速度、大小、主次排序、时间预测和特定结构不是必要补充，省去；不靠新增高级术语和旁枝显得完整。示意计算可用明确假设，不能把假设说成当前实测。",
  "最终解释围绕当前问题，保留理解所必需的条件。口语、类比和人格只改变讲法，不能改掉事实关系；内容讲清后自然结束。",
].join("\n");

/** Intent is resolved once for the turn. A tool-free final step must not turn
 * a knowledge answer into high-variance chat merely because tools were withheld. */
export function companionResponseStrategy(attention: CompanionTurnThinkingInput): {
  mode: "casual" | "knowledge" | "task";
  temperature: number;
  guidance: string;
} {
  if (attention?.intent === "conversation" && attention.toolUse === "none") {
    return { mode: "casual", temperature: 0.9, guidance: "" };
  }
  if (attention?.intent === "task" || attention?.intent === "task_control"
      || attention?.intent === "conversation") {
    // Intent describes what the user wants done, not whether the result contains
    // factual claims: drafting a lesson or editing a note can include a derivation.
    return { mode: "task", temperature: 0.4, guidance: COMPANION_KNOWLEDGE_REVIEW_V1 };
  }
  // Questions, mixed explanation/task turns and failed interpretation use the
  // stable explanation path, preserving the existing thinking decision.
  return { mode: "knowledge", temperature: 0.3, guidance: COMPANION_KNOWLEDGE_REVIEW_V1 };
}

/** Offline quality-comparison experiment only; production does not run a reviewer. */
export function isCompanionExplanation(attention: CompanionTurnThinkingInput,
  userText: string, offeredTools: number): boolean {
  return offeredTools === 0 && (attention?.intent === "question" || attention?.intent === "mixed")
    && /解释|讲讲|详细|为什么|原理|推导|讲清|理解|\b(?:explain|why|derive|detailed)\b/iu.test(userText);
}
