import { renderConversationSummary } from "./companion-summarizer.ts";
import type { CompanionRecentHistoryMessage } from "./companion-context-handoff.ts";

/**
 * `<conversation_summary>` 这一块的渲染入口：把「摘要自己没盖住的段」和
 * 「摘要盖到了、回放却没从那儿起」那一段**一起**说给她。
 *
 * 为什么要单独一条判据（2026-10-14 按真实会话核对）：链上的洞由
 * `readConversationSummaryChain` 报，但**摘要与回放之间**那一格只有等窗口裁完才知道——
 * 注入的那一块当时已经渲染好了。实测那条 565 条的会话里，注入块盖到 541、回放从 561 起，
 * 中间 19 条既没进摘要也没进回放，而 prompt 里一句「这段没读过」都没有；她于是把这块
 * 自称「更早那段对话」的摘要当成完整历史，接着往下编。
 *
 * 抽出来还有一个原因：`companion-dialogue.ts` 已经是个 1.5k 行的门面文件，
 * 这条判据不放在这儿，下一步就会被塞回调用点变成第二段内联规则。
 */
export interface SummaryCoverageGap {
  fromSeq: string;
  throughSeq: string;
}

/** read 阶段冻下来的渲染原料；窗口裁完之后由 `renderSummaryInjection` 消费。 */
export interface SummaryInjectionInput {
  /** 链头那份摘要的原始结构（`conversation_summaries.summary`）；null = 没有。 */
  source: unknown;
  /** 边界可信度判据（三份 coverage 列齐不齐），原样带回，不重新猜。 */
  coverageVerified: boolean;
  /** 接续链自己报出来的洞（`SummaryChainView.gaps`）。 */
  chainGaps: readonly SummaryCoverageGap[];
  /** 摘要实际盖到的最靠后 seq；与回放起点之间若有线上消息，那一格是洞。 */
  throughSeq: string | null;
}

/**
 * @param replayFromSeq 这一轮回放带走的头一条 seq；窗口还没裁时省略，只按链上的洞渲染。
 * @param visiblePage 本轮读回来的可见历史——数那一格里有几条用它，不拿 seq 差值当条数。
 */
export function renderSummaryInjection(
  input: SummaryInjectionInput,
  replayFromSeq?: string | null,
  visiblePage?: readonly CompanionRecentHistoryMessage[],
): string | null {
  if (input.source == null) return null;
  const gaps: SummaryCoverageGap[] = [...input.chainGaps];
  if (input.throughSeq && replayFromSeq) {
    const from = BigInt(input.throughSeq) + 1n;
    const through = BigInt(replayFromSeq) - 1n;
    const uncoveredCount = from <= through
      ? (visiblePage ?? []).filter(message => message.seq
        && BigInt(message.seq) >= from && BigInt(message.seq) <= through).length
      : 0;
    if (uncoveredCount > 0) {
      // 排在最前面：渲染出的那句话点的是**第一段**洞，而她这一轮最可能谈到的就是
      // 刚被挤出窗口的这几条。
      gaps.unshift({ fromSeq: from.toString(), throughSeq: through.toString() });
    }
  }
  return renderConversationSummary(input.source, {
    coverageVerified: input.coverageVerified,
    coverageGaps: gaps,
  });
}
