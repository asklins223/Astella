/** 未闭合语法先留在接收缓冲，闭合后仍由打字钟逐字显现。 */
export function stableCompanionMarkdownPrefix(source: string): string {
  let limit = source.length, lineStart = 0, fenced = false;
  let tableStart: number | null = null, tableConfirmed = false;
  let tablePipes = 0;
  const stack: { mark: string; start: number }[] = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim(), ended = lineStart + raw.length < source.length;
    if (trimmed.startsWith("```")) {
      if (!fenced && !ended) { limit = Math.min(limit, lineStart); break; }
      fenced = !fenced; lineStart += raw.length + 1; continue;
    }
    if (fenced) { lineStart += raw.length + 1; continue; }
    if (!trimmed) { stack.length = 0; tableStart = null; tableConfirmed = false; }
    if (trimmed.startsWith("|")) {
      if (tableStart === null) { tableStart = lineStart; tablePipes = trimmed.split("|").length - 1; }
      const pipes = trimmed.split("|").length - 1;
      if (lineStart !== tableStart && trimmed.includes("-") && /^[|:\- \t]+$/.test(trimmed) && trimmed.endsWith("|") && pipes >= tablePipes) tableConfirmed = true;
      if (tableConfirmed && !ended && (!trimmed.endsWith("|") || pipes < tablePipes)) limit = Math.min(limit, lineStart);
    } else { tableStart = null; tableConfirmed = false; }
    if (!ended && /^(?:#{1,6}|[-+*]|\d+[.)]?|`{1,2})$/.test(trimmed)) limit = Math.min(limit, lineStart);
    let index = lineStart;
    const end = lineStart + raw.length;
    while (index < end) {
      const character = source[index]!;
      if (character === "\\") { index += 2; continue; }
      let mark = character, length = 1;
      if ("*_~`$".includes(character)) {
        while (index + length < end && source[index + length] === character) length++;
        mark = character.repeat(length);
      } else if (!"[]()".includes(character)) { index++; continue; }
      const last = stack.at(-1);
      if (last?.mark.startsWith("`") && mark !== last.mark) { index += length; continue; }
      if (mark === "[") stack.push({ mark, start: index });
      else if (mark === "]" && last?.mark === "[") {
        const opening = stack.pop()!;
        if (index + 1 === end && !ended) stack.push({ mark: "link", start: opening.start });
        else if (source[index + 1] === "(") { stack.push({ mark: "link", start: opening.start }); index++; }
      } else if (mark === ")" && last?.mark === "link") stack.pop();
      else if (!["(", ")", "]"].includes(mark)) {
        if (last?.mark === mark) stack.pop();
        else if (index + length === end || !/\s/.test(source[index + length]!)) stack.push({ mark, start: index });
      }
      index += length;
    }
    lineStart += raw.length + 1;
  }
  if (tableStart !== null && !tableConfirmed) limit = Math.min(limit, tableStart);
  if (stack.length) limit = Math.min(limit, stack[0]!.start);
  return source.slice(0, limit);
}
