import { readCompanionDeliveryDraft } from "../tools/companion-delivery-draft.ts";
import type { AgentTurnRequest } from "@astella/shared";
import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";
import type { AgentGoalDeliveryV1 } from "@astella/shared/agent-contracts";
import { currentCompanionSuccessfulReceipts } from "../tools/companion-tool-receipts.ts";

export type CompanionFinishRequirement = Omit<AgentGoalDeliveryV1["requirements"][number], "textOnly">;

export type CompanionFinishArguments = {
  text?: string;
  silent?: boolean;
  actions: Array<{ receiptId: string }>;
  evidence: Array<{ receiptId: string }>;
  outcome?: "completed" | "partial" | "needs_input" | "failed";
  requirements?: CompanionFinishRequirement[];
};
export type CompanionFinishVerdict =
  | { ok: true; text: string; writesLanded: boolean }
  | { ok: false; error: string };

export const companionCurrentSuccessfulToolReceipts = currentCompanionSuccessfulReceipts;

/** A finish that only repeats speech already published in this run is not a
 * new delivery; the explicit message channel carried it. Exact text only, so
 * paraphrases and new remarks still deliver. */
export function companionFinishRepeatsPublished(finishText: string, publishedTexts: readonly string[]): boolean {
  const normalize = (value: string) => stripVoiceExpressionTags(value).replace(/\s+/gu, " ").trim();
  const target = normalize(finishText);
  if (!target) return false;
  if (publishedTexts.some(text => normalize(text) === target)) return true;
  return publishedTexts.length > 1 && normalize(publishedTexts.join(" ")) === target;
}
const DELIVERABLE_READ_OPERATIONS = new Set(["visual.diagram"]);

/** Reuse an actual body after the current request boundary. A sole finish call
 * may deliver its accompanying body; business-tool preambles cannot. */
export function companionLatestDeliveryDraft(messages: AgentTurnRequest["messages"]): string | null {
  let boundary = messages.length - 1;
  while (boundary >= 0 && messages[boundary]!.requestBoundary !== true) boundary--;
  if (boundary < 0) return null;
  for (let i = messages.length - 1; i > boundary; i--) {
    const message = messages[i]!;
    const savedDraft = readCompanionDeliveryDraft(message, messages[boundary]!);
    if (savedDraft !== null) return savedDraft;
    const deliveryOnly = !message.toolCalls?.length || (message.toolCalls.length === 1
      && message.toolCalls[0]!.name === "companion_finish");
    if (message.role === "assistant" && deliveryOnly && typeof message.content === "string"
      && message.content.trim()) return message.content;
  }
  return null;
}

/** Verify declared coverage and references, never infer intent from prose.
 * Semantic completeness still needs model/evaluation: a ledger cannot prove
 * that the model understood every goal or that a proof is mathematically sound. */
export function validateCompanionFinish(input: CompanionFinishArguments, messages: AgentTurnRequest["messages"],
  options: { requireRequirements?: boolean; allowSilent?: boolean; currentRunEvidence?: AgentTurnRequest["messages"] } = {}): CompanionFinishVerdict {
  const successful = new Map(currentCompanionSuccessfulReceipts(messages, options.currentRunEvidence).map(receipt => [receipt.id, receipt]));
  if (input.silent) {
    if (!options.allowSilent || input.text?.trim() || input.actions?.length || input.evidence?.length
      || [...successful.values()].some(receipt => receipt.riskClass !== "read"))
      return { ok: false, error: "安静结束只适用于没有待交付结果的主动参与；用户请求、正文和实际写入不能静默省略。" };
    return { ok: true, text: "", writesLanded: false };
  }
  const text = input.text === undefined ? companionLatestDeliveryDraft(messages) : input.text;
  if (!text?.trim() || !stripVoiceExpressionTags(text).trim())
    return { ok: false, error: "本轮没有可复用的完整草稿；历史回答和工具调用前言不能作为当前正文。请提供 text。" };
  const aliases = new Map<string, string | null>();
  for (const receipt of successful.values()) if (receipt.reference) {
    const existing = aliases.get(receipt.reference);
    aliases.set(receipt.reference, existing === undefined || existing === receipt.id ? receipt.id : null);
  }
  const resolve = (reference: string): string | undefined => {
    const raw = successful.has(reference) ? reference : undefined;
    const alias = aliases.get(reference);
    return alias === null || (raw && alias && raw !== alias) ? undefined : raw ?? alias;
  };
  const available = [...successful.values()].map(receipt => `${receipt.reference ?? receipt.id} (${receipt.operation})`).join("、") || "无";
  const writes = [...successful.values()].filter(receipt => receipt.riskClass !== "read");
  const actions = input.actions ?? [], evidence = input.evidence ?? [];
  const isActionReceipt = (reference: string) => {
    const id = resolve(reference);
    const receipt = id ? successful.get(id) : undefined;
    return receipt !== undefined && (receipt.riskClass !== "read" || DELIVERABLE_READ_OPERATIONS.has(receipt.operation));
  };
  const invalidAction = actions.find(action => !isActionReceipt(action.receiptId));
  if (invalidAction) return { ok: false, error: `回执 ${invalidAction.receiptId} 不是本轮真实成功、可直接交付的工具回执。`
    + `可引用的动作回执：${[...successful.values()].filter(receipt => isActionReceipt(receipt.id)).map(receipt => receipt.reference ?? receipt.id).join("、") || "无"}。未执行、失败、结果未知和历史回执不证明完成。` };
  const invalidEvidence = evidence.find(item => !resolve(item.receiptId));
  if (invalidEvidence) return { ok: false, error: `证据回执 ${invalidEvidence.receiptId} 不是本轮真实成功的工具回执。可用回执：${available}。` };
  const missing = writes.filter(receipt => !actions.some(action => resolve(action.receiptId) === receipt.id));
  if (missing.length) return { ok: false, error: `本轮成功写回执尚未全部引用：${missing.map(receipt => receipt.reference ?? receipt.id).join("、")}。引用已落下的回执，不要重复执行。` };
  if (options.requireRequirements && (!input.requirements?.length || !input.outcome))
    return { ok: false, error: "本轮已有写入或待发独立消息，交付需要 outcome 和 requirements：逐项对照当前请求，列出是否满足及本轮 evidenceCallIds。没有完成的目标如实保留，已经成功的部分不要重做。" };
  for (const requirement of input.requirements ?? []) {
    if (input.outcome === "completed" && !requirement.fulfilled)
      return { ok: false, error: `目标“${requirement.requirement}”尚未满足，不能宣布全部完成；继续处理或用 partial/needs_input/failed 如实交付。` };
    if (requirement.fulfilled && requirement.evidenceCallIds.length === 0)
      return { ok: false, error: `目标“${requirement.requirement}”需要真实工具回执，文字不能代替执行或读取。` };
    if (requirement.evidenceCallIds.some(id => !resolve(id)))
      return { ok: false, error: `目标“${requirement.requirement}”引用了未成功或不属于本轮的依据。可用回执：${available}。核对实际结果；不要重做已经成功的部分。` };
  }
  return { ok: true, text, writesLanded: writes.length > 0 || actions.some(action => isActionReceipt(action.receiptId)) };
}
