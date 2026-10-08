import type { AgentTurnRequest } from "@astella/shared";
import { keepRecomputedBlocks } from "./companion-dialogue-content.ts";

export function companionNumericEvidenceContext(messages: AgentTurnRequest["messages"]): string {
  // "她报的数字有没有出处"要比对的出处 = 本轮给她的**数据**：system 里的环境块/记忆块，
  // 以及用户自己说过的话。**不含她自己说过的话**——实机 2026-09-21 她先编了一次
  // "本周 23 分钟"（真值 60），下一轮就照着自己的历史复述这个数，
  // 于是"上下文里出现过"被历史里的谎洗白，闸永远不响。
  // 使用 baseMessages：工具结果只会出现在 messages 里，而那条闸
  // 只在整轮零工具调用时才判，两者不会互相掩盖。
  return messages
    .filter((message) => message.role !== "assistant")
    .map((message) => [
      message.role,
      typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join(" "),
    ] as const)
    .map(([role, text]) => (
      // system 那段里只有"本轮重算出来的块"算数字出处；用户说的话本身就是输入，全留。
      role === "system" ? keepRecomputedBlocks(text) : text
    ))
    .join("\n");
}
