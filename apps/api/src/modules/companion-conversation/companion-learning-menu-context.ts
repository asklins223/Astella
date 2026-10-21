/** 伴星提议正文的净化：控制字符压成空格、空白折叠、首尾裁掉。 */
export function sanitizeText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
