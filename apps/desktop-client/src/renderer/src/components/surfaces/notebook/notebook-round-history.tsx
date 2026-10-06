/**
 * 「学习记录（轮次足迹）」那张表。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 34 行、8 个外部符号，是那块文件里依赖数最少的区域之一。三个标签函数
 * （`roundRecordDayV1` / `roundRecordModesLabelV1` / `roundHistoryStateLabelV1`）
 * 已经是模块级的纯函数，搬过来直接引用即可，不需要重写。
 *
 * 与 `notebook-recall-paper` 同一轮的产物：那一次的关键是先给
 * `actOnActiveRecall` 的判别联合起了名字（`notebook-recall-contract.ts`），
 * **契约具名之后，搬实现就不再有代价**。这一次不需要，因为这里本来就没有匿名内联联合。
 *
 * ⚠️ JSX 逐字搬。这张表的三档状态字与「更早的那几页」那颗按钮的 disabled 条件
 * 都是从服务端状态推出来的，改判据会让「读不到」画成「没有记录」。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ReactElement } from "react";
import type { NoteLearningRoundHistoryV1 } from "@astella/shared/note-learning-round-contracts";
import { ROUND_COPY } from "./notebook-round-copy.ts";

export function NotebookRoundHistory(props: {
  /** 服务端那一页的原始行——标签在组件里按行算（与原实现同序）。 */
  readonly items: readonly NoteLearningRoundHistoryV1["items"][number][];
  /** 履历总数。`0` 与「还没读到」不是一回事，所以它是独立的一个数。 */
  readonly total: number;
  readonly hasMore: boolean;
  readonly busy: boolean;
  readonly failure: string | null;
  /** 三个标签函数照真实签名传（`round-record-copy.ts`），不在这里重写一遍。 */
  readonly recordDay: (value: string) => string;
  readonly recordModesLabel: (modes: readonly ("explained" | "practiced")[]) => string;
  readonly historyStateLabel: (item: { phase: "active" | "paused" | "closed"; outcome: string | null }) => string;
  readonly onInspect: (roundId: string) => void;
  readonly onLoadOlder: () => void;
}): ReactElement {
  const {
    items: historyItems,
    total: historyTotal,
    hasMore: historyHasMore,
    busy: olderBusy,
    failure: olderFailure,
    recordDay: roundRecordDayV1,
    recordModesLabel: roundRecordModesLabelV1,
    historyStateLabel: roundHistoryStateLabelV1,
    onInspect: inspectRoundInFootprint,
    onLoadOlder: loadOlderRounds,
  } = props;
  return (
<section className="notebook-round-history">
  <p className="small notebook-note">{ROUND_COPY.historyLead(historyTotal, historyItems.length, historyHasMore)}</p>
  <ol className="notebook-round-history__list">
    {historyItems.map((item) => (
      <li key={item.roundId}>
        <span className="small notebook-round-history__day">{roundRecordDayV1(item.startedAt)}</span>
        <span className="small notebook-round-history__state">{roundHistoryStateLabelV1(item)}</span>
        <span className="notebook-round-history__question">{item.drivingQuestion}</span>
        {!("contentMasked" in item && item.contentMasked) ? <button type="button" className="text-action" onClick={() => inspectRoundInFootprint(item.roundId)}>查看这一轮</button> : null}
        {item.actualModes.length > 0 ? (
          <span className="small notebook-round-history__modes" data-round-history-modes="true">
            {roundRecordModesLabelV1(item.actualModes)}
          </span>
        ) : null}
        {item.followUpSettledAt ? (
          <span className="small notebook-round-history__follow-up" data-round-history-follow-up="true">
            {ROUND_COPY.followUp(roundRecordDayV1(item.followUpSettledAt))}
          </span>
        ) : null}
        {item.systemUncertain ? (
          <span className="small notebook-round-history__uncertain" data-round-history-uncertain="true">
            {ROUND_COPY.historyUncertain}
          </span>
        ) : null}
      </li>
    ))}
  </ol>
  {historyHasMore ? (
    <button type="button" className="button" disabled={olderBusy} onClick={() => void loadOlderRounds()}>
      {olderBusy ? ROUND_COPY.loadingOlder : ROUND_COPY.loadOlder}
    </button>
  ) : null}
  {olderFailure ? <p className="small notebook-note" role="alert">{olderFailure}</p> : null}
</section>
  );
}
