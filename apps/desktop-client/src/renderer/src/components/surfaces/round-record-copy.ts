/**
 * §10.3 记录那一行的字与日期（39d W4-8 刀二抽出来共用）。
 *
 * 为什么要有这一份：记录要按**笔记**、也按**本人**两个级别出现（笔记页那一块与
 * 学习页那一块）。同一句"已收尾"在两屏各写一遍，就会有一天只改一边——读的人不会
 * 认为那是同一件事的两种说法，她会认为系统在说两件不同的事。所以：
 * 状态/结论/实际方式/判不准那四类字，以及"哪一天"的写法，只在这一处签发。
 */

/** 记录里那一行的日期（§10.3 只要"哪一天"，时刻在卡片历史那一侧看）。 */
const ROUND_DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function roundRecordDayV1(value: string): string {
  return ROUND_DAY_FORMAT.format(new Date(value));
}

/** §10.3 那一格里"完成／部分完成／中断"这三个字由这一处签发；`active` 不在其中。 */
export const ROUND_RECORD_COPY_V1 = {
  state: {
    active: "正在进行",
    paused: "停住了",
    closed: "已收尾",
  } as Record<"active" | "paused" | "closed", string>,
  outcome: {
    completed: "走完了",
    partial: "先到这里",
    superseded: "被新的一轮替掉",
    system_failure: "中途出了问题",
  } as Record<"completed" | "partial" | "superseded" | "system_failure", string>,
  /** 「实际方式」：只有真发生过的那一档才会有字（服务端报的集合，界面不补默认）。 */
  mode: {
    explained: "讲过",
    practiced: "练过",
  } as Record<"explained" | "practiced", string>,
  uncertain: "这次有我们判不准的地方",
  loadOlder: "看更早的几轮",
  loadingOlder: "正在取更早的…",
  /**
   * 按笔记那一级。`hasMore` 会改这句话的**量词**：只回了最近几条时报"开过 N 轮"
   * 就是个假总数，所以那种情况下只说"最近的这几轮"，不替整篇报数。
   */
  noteLead: (total: number, shown: number, hasMore: boolean) =>
    hasMore
      ? `这一篇开过 ${total} 轮，这里列了最近 ${shown} 轮，更早的还能看。`
      : `这一篇开过 ${total} 轮。`,
  /**
   * 本人那一级（学习页）。多带一个"几篇"：跨笔记那一屏只报轮数会读成"我在同一篇上
   * 反复开"，而 §10.3 要这一屏回答的恰好是"这一阵子学了哪些"。同样地，`hasMore`
   * 时不替整本记录报篇数——那两个数都只报服务端算出来的。
   */
  personalLead: (total: number, shown: number, hasMore: boolean) =>
    hasMore
      ? `我开过 ${total} 轮，这里列了最近 ${shown} 轮，更早的还能看。`
      : `我开过 ${total} 轮，都在上面了。`,
};

/** 未完成的只看状态、不猜原因；终态才看收尾原因（唯一的来源就是这两格）。 */
export function roundHistoryStateLabelV1(
  item: { phase: "active" | "paused" | "closed"; outcome: string | null },
): string {
  if (item.phase === "closed" && item.outcome) {
    return ROUND_RECORD_COPY_V1.outcome[item.outcome as keyof typeof ROUND_RECORD_COPY_V1.outcome];
  }
  return ROUND_RECORD_COPY_V1.state[item.phase];
}

/** 「实际方式」那一串（`讲过 · 练过`）；空集合回空串，由调用处整格不渲染。 */
export function roundRecordModesLabelV1(modes: readonly ("explained" | "practiced")[]): string {
  return modes.map((mode) => ROUND_RECORD_COPY_V1.mode[mode]).join(" · ");
}
