import { companionWebCitations } from "./companion-web-citations";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";

/** 复制手记中可阅读的文字，包括选文和富内容；不把内部动作身份带进剪贴板。 */
export function companionMessageCopyText(message: CompanionMessageV1): string {
  const sources = companionWebCitations(message.blocks);
  const readable = (text: string) => text.replace(/\[\^(web-[a-zA-Z0-9_-]+)\]/g, (_marker, id: string) => {
    const index = sources.findIndex(source => source.referenceId === id);
    return index < 0 ? "" : `[${index + 1}]`;
  });
  const parts = message.blocks.flatMap((block) => {
    switch (block.type) {
      case "text": return [readable(block.text)];
      case "quote": return [`${block.label}\n${block.text}`];
      case "code": return [block.code];
      case "diagram": return [block.title, ...block.steps.map((step, index) => `${index + 1}. ${step.label}${step.detail ? `\n${step.detail}` : ""}`)];
      case "card": return [block.front, ...(block.summary ? [block.summary] : [])];
      case "nav":
      case "image": return [block.label];
      case "citation": return [block.referenceId && block.target.kind === "external_https"
        ? `[${sources.findIndex(source => source.referenceId === block.referenceId) + 1}] ${block.label}\n${block.target.href}` : block.label];
      default: return [];
    }
  });
  if (message.role === "user" && message.selection) parts.unshift(`引用的原文\n${message.selection.text}`);
  return parts.filter((part) => part.length > 0).join("\n\n");
}
