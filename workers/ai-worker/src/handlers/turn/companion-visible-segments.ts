/**
 * 伴星多步正文的分段拼接（自 companion-agent-runtime.ts 拆出，2026-10-07）。
 *
 * 判据是**域**：这里只管"各步说过的话怎么拼成最终正文、什么段该丢、什么段算复读"，
 * 编排文件管"这一轮怎么读进来、这些步怎么走"。拆的动因是棘轮：本轮把输出预算改成
 * 按模型档案声明之后，运行时越过 1500 行——它本来就一直贴着阈值。
 */

/**
 * 多步可见正文的分段符（2026-09-19 ④-b）。
 *
 * 它与流式下发的 `separatorBefore` 必须是**同一个字符串**：交付管线累积的原文
 * 与最终正文逐字节同形，`reconcileStreamedText` 的"最终正文以已下发内容开头"
 * 才不需要任何放宽。改这里就要同时改 runStreamingAgentStep 的调用点，别只改一处。
 */
export const VISIBLE_SEGMENT_SEPARATOR = "\n\n";

/**
 * 分段拼接（去重版，2026-09-19 E 内容质量；④-b 的拼接不变量全部继承）。
 *
 * ④-b 原始口径（现在由去重版继续保证）：
 * - 判据是 `segment.length > 0` 而**不是**"trim 后非空"：分段符与分段内容是
 *   **先发后判**的（跑完那一步才知道它有没有吐字），所以只要这一步吐出过字符，
 *   它的分段符就已经在下发原文里了——这里必须同口径保留，否则"下发原文"与
 *   "最终正文"在分段边界上错位，`writeTail` 的 `fullText.startsWith(delivered)`
 *   会失败，整轮被判 `stream_full_text_diverged`。
 * - 同理**不对分段做 trim**：trim 掉的字符在流式侧是发出去过的，两侧必须共用
 *   同一段原文，净化统一在出口（validateCompanionOutput / 交付管线的 sanitize）做。
 *
 * 在此之上做两件事，都只动**从未流式下发过**的分段：
 * 1. 丢重复：与前面某个保留分段 trim 后完全相同的那一条（模型复读：工具步说完结论、
 *    终答步原样再说一遍）。
 * 2. 丢"夹在已下发段前面的未下发段"：这种段从没出现在下发原文里，却会排在已下发的
 *    内容前面——最终正文就不再以下发原文开头，`writeTail` 判
 *    `stream_full_text_diverged`，整轮失败。实机 2026-09-22 场景 T 就是这个形状：
 *    第 1 步"嗯嗯，记住了喵"被 hold 攒住没发出去 → 被 steer 掉 → 第 3 步真的调了工具
 *    并说出"好了，这次是真的设上了"，边界**其实改成功了**，run 却因为分叉被判 failed。
 *    末尾那条不丢：它是 writeTail 正要补发的尾巴。
 *
 * 已下发过的分段一律保留——它已经在客户端草稿里，删掉等于与最终正文分叉。
 */
export function joinVisibleSegmentsDeduped(
  segments: readonly string[],
  delivered: readonly boolean[],
): { text: string; dropped: string[] } {
  const lastDelivered = delivered.lastIndexOf(true);
  const kept: string[] = [];
  const keptKeys = new Set<string>();
  const dropped: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0) continue;
    if (!delivered[index] && index < lastDelivered) {
      dropped.push(segment);
      continue;
    }
    const key = segment.trim();
    if (key.length >= 8 && keptKeys.has(key) && !delivered[index]) {
      dropped.push(segment);
      continue;
    }
    if (key.length >= 8) keptKeys.add(key);
    kept.push(segment);
  }
  return { text: kept.join(VISIBLE_SEGMENT_SEPARATOR), dropped };
}

/**
 * 找出与前面某个分段完全重复的分段（④-b 的观测项）。
 *
 * "分段拼接"让模型的复读行为第一次变得**肉眼可见**：实机 C 轮里工具步已经说完
 * `复习入口已经准备好啦，点一下「前往」就能过去。要不要先喝口水再开始？`，终答步
 * 又原样说了一遍——拼起来就是同一句 34 字出现两次。system prompt 已要求"不要在
 * 最后一步原样复述"，但小模型不一定听；这里只做**可观测**（日志），不改行为，
 * 因为已下发的分段无法撤回（撤回等于与最终正文分叉）。
 *
 * 阈值 8 字：短句（"好的""嗯嗯"）重复是正常口语，不算问题。
 */
export function findDuplicateSegment(segments: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const segment of segments) {
    const key = segment.trim();
    if (key.length < 8) continue;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}
