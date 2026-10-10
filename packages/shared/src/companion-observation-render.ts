/**
 * 把一份交付观察写成给模型看的那几句（方案 50 §10.2）。
 *
 * 三条写死的口径：
 * - 只说段粒度的事实。**没有**"播到第几个字"这种位置——权威行只有段，
 *   谁在这里写出具体位置就是在编。
 * - 合成没成功的段不算"她话说了一半"（那本来就没有声音）。
 * - 这一条只是线索（`current_context_clue`）：不推进话题、不要求她向用户复述播报状态。
 */
import { companionObservationSetV1Schema } from "./contracts/companion-observation-contracts.ts";

export function renderCompanionDeliveryObservation(value: unknown, now = new Date()): string {
  const parsed = companionObservationSetV1Schema.safeParse(value);
  if (!parsed.success) return "";
  const lines: string[] = [];
  for (const entry of parsed.data.observations) {
    if (entry.withdrawal.expiresAt !== null && new Date(entry.withdrawal.expiresAt) <= now) continue;
    if (entry.kind !== "delivery") continue;
    const { segmentsPlayed, segmentsPrepared, failedSegmentCount, unfinishedPlayback } = entry.payload;
    const parts: string[] = [];
    if (unfinishedPlayback) {
      parts.push(`上一句的朗读只播到第 ${segmentsPlayed} 段（一共 ${segmentsPrepared} 段），后面那段不能假定对方听到了`);
    }
    if (failedSegmentCount > 0) parts.push(`有 ${failedSegmentCount} 段没播成`);
    if (parts.length === 0) continue;
    lines.push(parts.join("；") + "。这只作背景线索：用户没问就不要汇报播放情况，也不要把没播完的部分说成对方已经听过。");
  }
  return lines.join("\n");
}
