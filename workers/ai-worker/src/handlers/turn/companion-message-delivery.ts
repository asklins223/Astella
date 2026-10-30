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
