import type { RoundPlanV1 } from "@astella/shared/note-learning-round-contracts";
import { plainTextOfBlockV1, type TeachingExplainBlockV1 } from "./teaching/teaching-explain.ts";

/** A reading route through saved material, never a grading rubric or a mastery claim. */
export function suggestRoundQuestion(title: string, blocks: TeachingExplainBlockV1[]): string {
  const heading = blocks.find((block) => block.type === "heading"
    && plainTextOfBlockV1(block.text) && plainTextOfBlockV1(block.text) !== title.trim());
  const subject = heading ? plainTextOfBlockV1(heading.text) : title.trim();
  return subject
    ? `「${subject.slice(0, 180)}」在讲什么，什么时候能用上？`
    : "这篇笔记最值得弄懂的是什么，什么时候能用上？";
}

/**
 * 本轮的小路线（39 §4.3：一个小计划、2–4 个相关要点、说明预计量级与结束条件）。
 *
 * ## 此前的问题不是"文案不好"，是**每一步都在重打标题**
 *
 * 旧写法把问题原句嵌进每一步：没有小节时那一步是
 * 「从保存的正文中找出回答「<整句问题>」的依据」，收尾那一步是
 * 「围绕「<整句问题>」用一个例子检验理解」。而问题句**已经作为大标题印在纸面上了**
 * ——于是同一句话在屏上出现三遍：一遍标题、一遍计划第一步、一遍计划收尾。
 * 一屏三个同义句，读起来就是一堵没有信息量的字墙。
 *
 * 现在，计划**只说两件标题没说的事**：读哪几段（点名小节）、怎么检验。
 * 检验那一步讲的是**方法**（用一个具体例子），不是**对象**——对象已经在标题上了。
 */
export function buildRoundReadingPlan(question: string, blocks: TeachingExplainBlockV1[]): RoundPlanV1 {
  const headings = [...new Set(blocks.filter((block) => block.type === "heading")
    .map((block) => plainTextOfBlockV1(block.text)).filter(Boolean))];
  // 命名小节与问题共词是**正常**的——那正是在按问题挑相关小节，所以这里不做去重。
  const named = headings.filter((heading) => question.includes(heading));
  // 2–4 个要点是产品初始参数（§4.3）：小节不够就少给，**不拿问题句凑数**。
  const topics = (named.length ? named : headings).slice(0, 3);
  const reading = topics.length
    ? topics.map((heading) => ({ text: `读懂「${heading.slice(0, 120)}」，找出与本轮问题有关的依据` }))
    : [{ text: "从保存的正文里找出支持这个判断的依据" }];
  return {
    version: 1,
    steps: [
      ...reading,
      { text: "用一个具体例子检验理解；依据不足时先标出不确定处" },
    ],
    expectedScale: topics.length
      ? `${topics.length} 个阅读要点，加一次理解检验；随时可以先结束`
      : "一段阅读，加一次理解检验；随时可以先结束",
    endCondition: "能解释本轮问题并说明适用条件，或明确记录仍需确认的部分",
  };
}
