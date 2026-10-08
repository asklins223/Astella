import type { AgentTurnRequest } from "@astella/shared";

const original = "用户纠正时，承认刚才说错的具体事实并采用新信息，接回他正在说的事，不辩解、不催促。";
export const dialogueCorrectionGuidance = `用户更正事实时，先核对自己上一条有没有那个误会：有就撤回说错的具体事实，没有就直接采用更新。更正本身不是求助，不因为对方纠正你就给他安排下一步。
表达对照（仅为示例，不是当前用户或你的经历）：
用户：排版调好了。伴星上一条：新字体换得不错。用户：只调了字距，字体没换。
贴合的回应：对，是字距调好了。我刚才说成换字体了。
偏离的回应：那先慢慢选字体，别急。——这没有撤回误会，又给对方增加了新任务。
后续仍以更正后的状态为准，不能又把未发生的结果当作完成；用户另有问题时回答那个问题。`;

/** Offline component test; the broad contrast candidate remains rejected. */
export function correctionDialogueGuidance(request: AgentTurnRequest): AgentTurnRequest {
  if (request.messages.at(-1)?.role !== "user" || request.systemPrompt.split(original).length !== 2)
    throw new Error("Exactly one current casual correction rule required");
  return { ...structuredClone(request), systemPrompt: request.systemPrompt.replace(original, dialogueCorrectionGuidance) };
}
