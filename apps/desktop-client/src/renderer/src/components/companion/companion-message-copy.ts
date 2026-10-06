import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";

/** 复制手记中可阅读的文字，包括选文和富内容；不把内部动作身份带进剪贴板。 */
export function companionMessageCopyText(message: CompanionMessageV1): string {
  const parts = message.blocks.flatMap((block) => {
    switch (block.type) {
      case "text": return [block.text];
      case "quote": return [`${block.label}\n${block.text}`];
      case "code": return [block.code];
      case "diagram": return [block.title, ...block.steps.map((step, index) => `${index + 1}. ${step.label}${step.detail ? `\n${step.detail}` : ""}`)];
      case "card": return [block.front, ...(block.summary ? [block.summary] : [])];
      case "nav":
      case "image":
      case "citation": return [block.label];
      default: return [];
    }
  });
  if (message.role === "user" && message.selection) parts.unshift(`引用的原文\n${message.selection.text}`);
  return parts.filter((part) => part.length > 0).join("\n\n");
}
