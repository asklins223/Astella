import type { RecallExcerpt } from "./recall-excerpt.ts";

type MissingPhrase = { sentence: string; phrase: string; start: number };

/** A short recall is a gap in an actual statement, never an invented topic or answer. */
function missingPhrase(text: string): MissingPhrase | null {
  const sentences = text.replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .split(/[。！？\n]/u).map(value => value.trim()).filter(value => value.length >= 12 && value.length <= 150);
  for (const sentence of sentences) {
    const change = /(?:从|由)\s*([\d.]+\s*[\p{L}%％]*)\s*(?:降到|降至|提高到|提升到|压到|变成|变为|到|至)\s*([\d.]+\s*[\p{L}%％]*)/u.exec(sentence);
    if (change?.[2]) return { sentence, phrase: change[2], start: change.index + change[0].lastIndexOf(change[2]) };
    const relation = /(?:加入|纳入|计入|换成|替换为|称为|叫作|依赖于|取决于|通过|采用|支持)\s*([^，,；;：:]{2,32}?)(?=后[，,]|来|进行|实现|[，,；;]|$)/u.exec(sentence);
    if (relation?.[1]) return { sentence, phrase: relation[1], start: relation.index + relation[0].indexOf(relation[1]) };
  }
  for (const sentence of sentences) {
    const clauses = sentence.split(/[，,；;]/u).map(value => value.trim()).filter(value => value.length >= 4 && value.length <= 28);
    const phrase = clauses.length > 1 ? clauses.at(-1) : null;
    if (phrase) return { sentence, phrase, start: sentence.lastIndexOf(phrase) };
  }
  return null;
}

export function deterministicRecallPrompt(basis: Pick<RecallExcerpt, "text" | "title">): { question: string; hint: string } {
  const gap = missingPhrase(basis.text);
  if (!gap) {
    const subject = basis.title || basis.text.slice(0, 32).replace(/[，,。].*$/u, "");
    return { question: `关于「${subject}」，你还记得原文怎样解释它吗？`, hint: `先围绕「${subject}」想一个关键词，再用自己的话接下去。` };
  }
  const question = `原文说：「${gap.sentence.slice(0, gap.start)}＿＿＿${gap.sentence.slice(gap.start + gap.phrase.length)}。」这里缺的是什么？`;
  // A different, exact clause supplies context; the missing phrase must never leak into the cue.
  const context = gap.sentence.split(/[，,；;]/u).map(value => value.trim())
    .find(value => value.length >= 6 && !value.includes(gap.phrase));
  const units = /^\d/u.test(gap.phrase) ? gap.phrase.replace(/[\d.\s]/gu, "") : "";
  const kind = /^\d/u.test(gap.phrase) ? `一个数值${units ? `，单位是 ${units}` : ""}`
    : /^[\p{Script=Han}]+$/u.test(gap.phrase) ? `一个${gap.phrase.length}字的词语或短语` : "一个名称或说法";
  const hint = context
    ? `和空缺相连的是「${context}」。要补的是${kind}，先想想这两部分怎样接起来。`
    : `看看空缺前后的原句。要补的是${kind}${basis.title && !basis.title.includes(gap.phrase) ? `，这一节在讲「${basis.title}」` : ""}。`;
  return { question, hint };
}
