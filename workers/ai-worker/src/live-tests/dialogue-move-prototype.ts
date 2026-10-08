import type { AgentTurnRequest } from "@astella/shared";
import { companionStepRuntimePolicy } from "../handlers/companion-step-plan.ts";
import { COMPANION_CASUAL_POLICY_BASE_V1 } from "../handlers/companion-conversation-policy.ts";

export type DialogueMovePrototype = "share" | "correction" | "pushback";
const moves: Record<DialogueMovePrototype, string> = {
  share: "本轮交流动作是参与分享：就对方说到的具体事情给出你的反应、看法或贴题好奇。对方没有把这件事交给你处理，这次发言只参与这段交流。谈事情，不给对方下心理、能力或表现结论，不把自己的推测当成他已经做过的事。",
  correction: "本轮交流动作是修复误会：对方在更正你。先撤回自己说错的具体那一点，把当前更正作为这段交流的更新，再沿更新后的事实接话。此轮要完成的是修复误会，不是为原说法另找理由、评价对方表现或给他安排后续。",
  pushback: "本轮交流动作是接受对方对你接话方式的反馈：撤回不合适的评价，回应对方明确说到的事实和感受。理解这次反馈并改接法就完成本轮；不辩解原话，不再解释对方为什么应该有这种心情，也不重新评价这件事值不值得。",
};

/** Oracle-selected capability diagnostic; not a production classifier or plan. */
export function movePrototypeRequest(request: AgentTurnRequest, move: DialogueMovePrototype): AgentTurnRequest {
  const current = companionStepRuntimePolicy({ permissionLevel: "read_only", toolCount: 0,
    stepBudget: 3, finalAnswerOnly: false, attentionIntent: "conversation" });
  const original = request.systemPrompt.includes(current) ? current : COMPANION_CASUAL_POLICY_BASE_V1;
  if (request.messages.at(-1)?.role !== "user" || request.systemPrompt.split(original).length !== 2)
    throw new Error("Exactly one existing casual execution policy required");
  const policy = [
    "本轮生成伴星参与当前日常对话的下一条发言。用户原话和最新纠正是当下交流的依据，自己的历史发言可能有误。",
    "这一轮没有工具；实际读取、保存和操作仍只按已有回执说。",
    moves[move],
    "人格来自账户设定。你的反应、看法和好奇以实际可见的事情为依据，不补出自己的亲身见闻；完成这一次交流回应就结束本轮，用户再接话时再继续。",
  ].join("\n");
  return { ...structuredClone(request), systemPrompt: request.systemPrompt.replace(original, policy) };
}
