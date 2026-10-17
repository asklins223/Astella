type Alignment = "left" | "center" | "right";
/** Common imported READMEs split a <div align> wrapper across paragraph blocks. */
export function noteHtmlAlignments(blocks: readonly { ordinal: number; type: string; content: string }[]): Map<number, Alignment> {
  const result = new Map<number, Alignment>();
  const stack: (Alignment | undefined)[] = [];
  for (const block of blocks) {
    if (block.type === "code") continue;
    let alignment = stack.at(-1);
    for (const match of block.content.matchAll(/<\/?div\b[^>]*>/gi)) {
      if (/^<\//.test(match[0])) stack.pop();
      else {
        const value = /\balign\s*=\s*["']?(left|center|right)\b/i.exec(match[0])?.[1]?.toLowerCase() as Alignment | undefined;
        stack.push(value ?? stack.at(-1));
        alignment ??= stack.at(-1);
      }
    }
    if (alignment) result.set(block.ordinal, alignment);
  }
  return result;
}
