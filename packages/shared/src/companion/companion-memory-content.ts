/**
 * Memory prose normalization shared by extraction, direct writes and deletion.
 *
 * The same preference is commonly stored as "用户晚上九点以后不想被打扰" or
 * "晚上九点以后不想被打扰". Punctuation, whitespace, case and a leading
 * "用户/我" do not change what was promised, so they are ignored before deciding
 * whether one memory covers another.
 */
export function normalizeCompanionMemoryContent(content: string): string {
  return content.toLocaleLowerCase().replace(/[\s\p{P}]/gu, "").replace(/^(用户|我)/u, "");
}

/** True when `candidate` adds nothing beyond `existing`. */
export function companionMemoryContentCovers(existing: string, candidate: string): boolean {
  const left = normalizeCompanionMemoryContent(existing);
  const right = normalizeCompanionMemoryContent(candidate);
  return left.length >= 6 && right.length >= 6 && left.includes(right);
}

/**
 * True when two memories state the same fact rather than two related ones.
 *
 * "晚上九点后不想被打扰" and "晚上九点后不想被打扰，这段时间不要主动发消息"
 * are the same preference stated twice; the user saying "forget that one" means
 * both. Two different facts that merely share a topic stay distinct, so this
 * requires one normalized text to contain the other.
 */
export function sameCompanionMemoryFact(left: string, right: string): boolean {
  const a = normalizeCompanionMemoryContent(left), b = normalizeCompanionMemoryContent(right);
  if (a.length < 6 || b.length < 6) return a === b;
  return a.includes(b) || b.includes(a);
}
