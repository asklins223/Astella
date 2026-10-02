import { plainCompanionBubbleText } from "../../companion/companion-markdown";

/** Completed questions are headings, including records with an unclosed bold marker. */
export function recallQuestionText(value: string): string {
  return plainCompanionBubbleText(value)
    .replace(/^(?:好[，,]\s*)?(?:那我)?(?:不给答案[，,]\s*)?先问(?:你)?一个[：:]\s*/u, "")
    .replace(/^(?:\*{2,}|_{2,})\s*|\s*(?:\*{2,}|_{2,})$/gu, "")
    .trim();
}
