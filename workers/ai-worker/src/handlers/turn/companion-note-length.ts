import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";

export type CompanionNoteLength = { min: number; max: number };

function number(text: string): number | null {
  if (/^\d+$/u.test(text)) return Number(text);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let value = 0, digit = 0;
  for (const char of text) {
    if (char in digits) digit = digits[char];
    else if (char === "十" || char === "百" || char === "千") { value += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]); digit = 0; }
    else return null;
  }
  return value + digit;
}

/**
 * The length the user asked for when they asked for a note, parsed from this
 * turn only. Quoted examples and negated numbers are not requirements; when
 * several numbers appear, the last affirmative one wins.
 */
export function companionRequestedNoteLength(text: string): CompanionNoteLength | null {
  const value = text.normalize("NFKC").replace(/[“「『‘"]([^”」』’"]*)[”」』’"]/gu, "");
  if (/(?:什么是|是什么意思|多少字|如何统计|怎么算)[^。！？]*$/u.test(value)) return null;
  const numeral = "([\\d零一二两三四五六七八九十百千]+)";
  const lengths = [...value.matchAll(new RegExp(`(?:约|大约|大概|差不多|恰好|正好|至少|不少于|不超过|最多)?\\s*${numeral}\\s*(?:个)?字`, "gu"))];
  const length = lengths.filter(match => !/(?:不要|别|不用|并非|不是)[^，,。！？\n]{0,12}$/u.test(value.slice(0, match.index))).at(-1);
  if (!length || /[“「『"].*[”」』"]/u.test(length.input.slice(0, length.index))) return null;
  const target = number(length[1]);
  if (!target || !Number.isSafeInteger(target)) return null;
  return /至少|不少于/u.test(length[0]) ? { min: target, max: Infinity }
    : /不超过|最多/u.test(length[0]) ? { min: 1, max: target }
      : /恰好|正好/u.test(length[0]) ? { min: target, max: target }
        : { min: Math.ceil(target * 85 / 100), max: Math.floor(target * 115 / 100) };
}

export function companionVisibleCharacterCount(text: string): number {
  return Array.from(stripVoiceExpressionTags(text).replace(/```[\s\S]*?```/gu, "")
    .replace(/^ {0,3}#{1,6}\s+.*$/gmu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/<[^>]*>/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")).length;
}

/** The saved note body must meet the requested length; titles, punctuation and
 * Markdown syntax do not count. */
export function companionNoteLengthIssue(markdown: string, length: CompanionNoteLength): string | null {
  const count = companionVisibleCharacterCount(markdown);
  const { min, max } = length;
  if (count >= min && count <= max) return null;
  return `当前笔记正文按不含标点与空白统计为 ${count} 字，未满足当前请求的篇幅（${min}–${Number.isFinite(max) ? max : "不限"} 字）。请当场交付符合篇幅的完整正文和结尾。`;
}
