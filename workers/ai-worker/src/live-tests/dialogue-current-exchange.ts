import type { AgentTurnRequest } from "@astella/shared";

/** Diagnostic-only source anchor. No inferred mood, purpose, approval or stage.
 * The native messages remain intact; this exact copy emphasizes which words
 * the companion is currently responding to, including its own prior mistake. */
export function anchorDialogueCurrentExchange(request: AgentTurnRequest): AgentTurnRequest {
  const current = request.messages.at(-1);
  if (current?.role !== "user" || typeof current.content !== "string")
    throw new Error("Current native user text required");
  const priorAssistant = request.messages.slice(0, -1).reverse().find(message => message.role === "assistant");
  if (priorAssistant && typeof priorAssistant.content !== "string") throw new Error("Native text diagnostic only");
  const anchor = [
    "以下只重附正在接续的交谈原话，不是事实摘要，也不推断用户心情。当前用户原话优先；上一条伴星回复可能猜错，不是用户的经历、立场或对建议的接受。历史里的创作是伴星生成的内容，不是用户亲自讲述或双方现实活动。",
    "<current_exchange_data>",
    JSON.stringify({ ...(priorAssistant ? { previousAssistantUtterance: priorAssistant.content } : {}),
      currentUserUtterance: current.content }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"),
    "</current_exchange_data>",
  ].join("\n");
  return { ...structuredClone(request), systemPrompt: `${request.systemPrompt}\n\n${anchor}` };
}
