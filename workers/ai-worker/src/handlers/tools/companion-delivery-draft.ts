import type { AgentTurnRequest } from "@astella/shared";
import { sha256Utf8V1 } from "@astella/shared/content-hash";

type Message = AgentTurnRequest["messages"][number];
const PREFIX = "本轮未发布草稿数据；用户尚未收到，不能计入已发送消息。\n<answer_draft_data>\n";
const SUFFIX = "\n</answer_draft_data>";

export function companionDeliveryDraftMessage(request: Message, text: string): Message {
  return { role: "system", hostObservation: true, content: PREFIX + JSON.stringify({
    version: 1, requestHash: sha256Utf8V1(JSON.stringify(request.content)),
    textHash: sha256Utf8V1(text), text,
  }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") + SUFFIX };
}

export function isCompanionDeliveryDraftMessage(message: Message): boolean {
  return message.role === "system" && message.hostObservation === true
    && typeof message.content === "string" && message.content.startsWith(PREFIX) && message.content.endsWith(SUFFIX);
}

/** Only a host-owned, hash-bound draft from this request is reusable. Its
 * system/data identity survives checkpoints without inventing assistant speech. */
export function readCompanionDeliveryDraft(message: Message, request: Message): string | null {
  if (!isCompanionDeliveryDraftMessage(message)) return null;
  try {
    const value = JSON.parse((message.content as string).slice(PREFIX.length, -SUFFIX.length)) as Record<string, unknown>;
    return value.version === 1 && typeof value.text === "string" && value.text.trim()
      && value.requestHash === sha256Utf8V1(JSON.stringify(request.content))
      && value.textHash === sha256Utf8V1(value.text) ? value.text : null;
  } catch { return null; }
}
