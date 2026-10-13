/** A model may spell out its quiet decision instead of returning empty content.
 * Execution closure is never a user message; this does not classify user intent. */
export function isCompanionParticipationClosure(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length > 240) return false;
  const text = value.trim().replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "").trim();
  return /^(?:安静|静默)(?:结束|收尾)(?:[，,；;：:。.!！\s].*)?$/.test(text)
    || /^(?:本轮|本次)(?:不发言|无需发言|无更多内容|没有新内容)(?:[，,；;：:。.!！\s].*)?$/.test(text)
    || /^(?:这轮|这一轮|本轮|这次|本次)(?:没有|没|无需|无须|不需要).{0,60}(?:补充|新内容|发言).{0,30}(?:安静|静默|不发言|结束|收尾)[。.!！\s]*$/.test(text)
    || /^提醒已发[，,；;：:。.!！\s]+(?:本轮|本次)(?:无更多内容|没有新内容|结束)/.test(text);
}
