/** The model interprets a request for independent messages. The host counts
 * actual publications, preserving that contract across retries and resumes. */
export function createCompanionMessageDelivery(initialCount: number | null = null) {
  let requestedCount = initialCount;
  const publishedIds = new Set<string>();
  return {
    get requestedCount() { return requestedCount; },
    require: (count: number | null) => {
      if (count !== null && (!Number.isSafeInteger(count) || count < 1))
        throw new Error("invalid independent-message contract");
      if (requestedCount !== null && count !== requestedCount)
        throw new Error("independent-message contract changed during the turn");
      requestedCount = count;
    },
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

const CN_DIGITS: Record<string, number> = { 一:1, 两:2, 二:2, 三:3, 四:4, 五:5, 六:6 };

/**
 * A count the user actually stated: "分两条", "分 3 条消息", "用两条独立消息".
 * The tool description already promises "用户点了条数就按条数调用"; the host
 * counted nothing, so a model answering one combined line looked compliant.
 * Only an explicit count next to 条/则/段 message words qualifies — this is a
 * number, not a reading of the sentence's meaning.
 */
const EXPLICIT_MESSAGE_COUNT =
  /(?:分成?|拆成?|用|发)\s*([1-9一二两三四五六])\s*(?:条|则)(?:独立的?|分开的?)?(?:消息|气泡|回复|话)?/u;

export function requestedIndependentMessageCount(userText: string | null | undefined): number | null {
  if (!userText) return null;
  const match = EXPLICIT_MESSAGE_COUNT.exec(userText);
  if (!match) return null;
  const raw = match[1]!;
  const value = /\d/.test(raw) ? Number(raw) : CN_DIGITS[raw];
  return value && value >= 2 && value <= 6 ? value : null;
}
