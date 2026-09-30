/**
 * 题面区那块「求助」面板：提示一层一层给出来。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * `LearningRunBody` 剩下 1800 行是一整个巨型条件，整体不可切；但里面**有几块是自足的**
 * ——这块只依赖 2 个外部符号。
 *
 * ## P21（B4）：这块为什么要住在题面区，而不是左侧导航栏
 *
 * 2026-09-21 实机截图发现：提示文字此前落在侧栏里 207px 宽的一栏、9px 字号，而
 * 「看过提示这轮只计练习分」那句只有 **7.5px** ——**全链路最小、却是最该看清的一句**；
 * 而且求助信息和它要帮的那道题还隔着 250px。
 *
 * ## ⚠️ 那段注释是这个组件存在的一半，别删（实机截图 2026-09-21）
 *
 * `.learning-run-hint` 是 `auto minmax(0,1fr)` 两列网格，图标占第一列。
 * 先前**提示层**与「只计练习分」那句是**并列的两个网格项**，于是那句被自动放进
 * 第二行第一列，而 `auto` 列按它的 max-content 撑满整块面板，把提示层挤成十几像素宽
 * 的一条竖排字。**提示正文必须包在一个元素里**——包一层之后网格永远只有两个子项，
 * 第三行内容再怎么加也挤不到正文列。
 */
import type { ReactElement } from "react";
import { Lightbulb } from "lucide-react";

export type LearningRunHintEntryV1 = {
  readonly level: number;
  readonly text: string;
  /** 这一层是不是「降级过的」——降级过就要在面板里说清它只计练习分。 */
  readonly downgraded: boolean;
};

export function LearningRunHint(props: {
  readonly entries: readonly LearningRunHintEntryV1[];
  /**
   * 本轮来自「本轮学习」还是别处——两者的措辞不同（措辞差别是产品裁决）。
   *
   * 这里收**布尔**而不是 `originV2.kind` 那个联合：那个联合还有 `review` / `today` /
   * `star_market` 等档，而这两句文案只分「本轮」与「不是本轮」两种。
   * 把联合写进来就等于说「只有这两种」，那是我编的。
   */
  readonly isNoteRound: boolean;
}): ReactElement {
  const { entries, isNoteRound } = props;
  return (
    <div className="learning-run-hint learning-run-hint--shown" role="status">
      <Lightbulb size={15} aria-hidden="true" />
      <div className="learning-run-hint__body">
        <ol className="learning-run-hint__levels">
          {entries.map((entry) => (
            <li key={entry.level}><span>{entry.text}</span></li>
          ))}
        </ol>
        {entries.some((entry) => entry.downgraded) ? <small>{isNoteRound ? "看过提示后，这次仍只记作练习，不作为独立掌握证据。" : "看过提示之后，这张卡本轮只计练习分，不再计正式理解分。"}</small> : null}
      </div>
    </div>
  );
}
