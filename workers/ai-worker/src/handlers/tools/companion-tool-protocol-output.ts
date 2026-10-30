/** Native tool syntax is a transport record, not assistant prose. Code examples
 * remain valid Markdown; an unfinished inline span is held while streaming. */
export function proseOutsideCode(text: string, streaming: boolean): { prose: string; pendingInlineAt: number | null } {
  let fence: { marker: string; length: number } | null = null;
  let masked = text.split(/(?<=\n)/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length
        && line.slice(marker[0].length).trim() === "") fence = null;
      return line.replace(/[^\r\n]/g, " ");
    }
    if (marker) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      return line.replace(/[^\r\n]/g, " ");
    }
    return line;
  }).join("");
  let at = 0;
  let pendingInlineAt: number | null = null;
  while ((at = masked.indexOf("`", at)) >= 0) {
    let end = at + 1;
    while (masked[end] === "`") end++;
    const delimiter = masked.slice(at, end);
    let close = masked.indexOf(delimiter, end);
    while (close >= 0 && (masked[close - 1] === "`" || masked[close + delimiter.length] === "`"))
      close = masked.indexOf(delimiter, close + 1);
    if (close < 0 && !streaming) { at = end; continue; }
    if (close < 0) pendingInlineAt = at;
    const through = close < 0 ? masked.length : close + delimiter.length;
    masked = masked.slice(0, at) + masked.slice(at, through).replace(/[^\r\n]/g, " ") + masked.slice(through);
    at = through;
  }
  return { prose: masked, pendingInlineAt };
}

const TOOL_PROTOCOL_MARKER = /<\/?(?:tool_calls?|function_calls?)(?=[\s>/])|<(?:function|parameter)\s*=/iu;
const TOOL_PROTOCOL_HEADS = ["<tool_call", "</tool_call", "<tool_calls", "</tool_calls",
  "<function_call", "</function_call", "<function_calls", "</function_calls", "<function=", "<parameter="];

export function containsCompanionToolProtocol(text: string, streaming = false): boolean {
  return TOOL_PROTOCOL_MARKER.test(proseOutsideCode(text, streaming).prose);
}

/** Never publish half a reserved marker before enough bytes arrive to reject it. */
export function withholdPartialCompanionToolProtocol(text: string): string {
  const { prose, pendingInlineAt } = proseOutsideCode(text, true);
  const safeText = pendingInlineAt === null ? text : text.slice(0, pendingInlineAt);
  const open = prose.lastIndexOf("<");
  if (open < 0) return safeText;
  const suffix = prose.slice(open).replace(/\s/g, "").toLowerCase();
  return TOOL_PROTOCOL_HEADS.some(head => head.startsWith(suffix)) ? safeText.slice(0, open) : safeText;
}

/** Reserved host data envelopes are a protocol shape. Ordinary field names,
 * UUIDs, quoted examples and code are not evidence of context leakage. */
export function containsCompanionContextEnvelope(text: string): boolean {
  const prose = proseOutsideCode(text, false).prose;
  return /^\s*<(?:memory_data|memory_directory|persona_data|selection_data|diary_reference|page_context|grounded_target|here_and_now|conversation_timeline|answer_draft_data|review_context_data)>/mu.test(prose);
}
