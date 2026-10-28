/** Only an explicit request for separate messages creates a delivery contract.
 * Lists, quoted examples, historical requests and a vague "two points" don't.
 * This is an output constraint, not an intent classifier or a tool grant. */
export function requestedCompanionMessageCount(userText: string): number | null {
  const text = userText.trim();
  const match = /^(?:请|请你|麻烦(?:你)?|帮我|请帮我)?\s*(?:分(?:成|为)?|拆(?:成|为)?)\s*([2-9]|[1-9]\d|两|二|三|四|五|六|七|八|九|十)\s*(?:条|个)\s*(?:独立的?|单独的?)?\s*(?:消息|气泡)/u.exec(text)
    ?? /^(?:please\s+)?(?:send|reply|respond)\b[^.!?\n]{0,50}\b(?:in|as)\s+(\d+|two|three|four|five)\s+(?:separate\s+)?messages\b/iu.exec(text);
  if (!match) return null;
  const words: Record<string, number> = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    two: 2, three: 3, four: 4, five: 5 };
  const count = words[match[1]!.toLowerCase()] ?? Number(match[1]);
  return Number.isSafeInteger(count) && count >= 2 ? count : null;
}

export function createCompanionMessageDelivery(userText: string, enabled = true) {
  const requestedCount = enabled ? requestedCompanionMessageCount(userText) : null;
  const publishedIds = new Set<string>();
  return {
    requestedCount,
    record: (messageId: string) => { publishedIds.add(messageId); },
    incomplete: () => requestedCount !== null && publishedIds.size < requestedCount,
    full: () => requestedCount !== null && publishedIds.size >= requestedCount,
    guidance: () => requestedCount === null ? ""
      : `用户明确要求 ${requestedCount} 条独立消息，当前已经实际发布 ${publishedIds.size} 条。`
        + (publishedIds.size >= requestedCount
          ? "指定消息已发完，不再发布额外气泡，也不复述或汇报已经发了什么；只继续完成尚未落实的其他要求。"
          : `仍须用 companion_send_message 发布其余 ${requestedCount - publishedIds.size} 条，每次调用只发一条。前面的消息 final=false，最后一条才 final=true。正文是草稿，不算已发送；不要用编号、空行或一句口头确认代替独立消息。先完成用户要求的计算、读取或写入，再按真实结果发送。`),
  };
}
