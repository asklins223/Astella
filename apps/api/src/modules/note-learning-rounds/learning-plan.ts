import type { RoundPlanV1 } from "@ailearn/shared/note-learning-round-contracts";
import { plainTextOfBlockV1, type TeachingExplainBlockV1 } from "./teaching-explain.ts";

/** A reading route through saved material, never a grading rubric or a mastery claim. */
export function suggestRoundQuestion(title: string, blocks: TeachingExplainBlockV1[]): string {
  const heading = blocks.find((block) => block.type === "heading"
    && plainTextOfBlockV1(block.text) && plainTextOfBlockV1(block.text) !== title.trim());
  const subject = heading ? plainTextOfBlockV1(heading.text) : title.trim();
  return subject
    ? `「${subject.slice(0, 180)}」在讲什么，什么时候能用上？`
    : "这篇笔记最值得弄懂的是什么，什么时候能用上？";
}

export function buildRoundReadingPlan(question: string, blocks: TeachingExplainBlockV1[]): RoundPlanV1 {
  const headings = [...new Set(blocks.filter((block) => block.type === "heading")
    .map((block) => plainTextOfBlockV1(block.text)).filter(Boolean))];
  const named = headings.filter((heading) => question.includes(heading));
  const topics = (named.length ? named : headings).slice(0, 3);
  return {
    version: 1,
    steps: [
      ...(topics.length ? topics.map((heading) => ({ text: `读懂「${heading.slice(0, 180)}」，找出与本轮问题有关的依据` }))
        : [{ text: `从保存的正文中找出回答「${question.slice(0, 180)}」的依据` }]),
      { text: `围绕「${question.slice(0, 180)}」用一个例子检验理解；依据不足时先标出不确定处` },
    ],
    expectedScale: `${topics.length || 1} 个阅读要点，加一次理解检验；随时可以先结束`,
    endCondition: "能解释本轮问题并说明适用条件，或明确记录仍需确认的部分",
  };
}
