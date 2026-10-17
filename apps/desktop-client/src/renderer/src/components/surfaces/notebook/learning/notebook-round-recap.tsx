/**
 * 「这一轮回看」那一格：翻开某一轮当时的问题、练过什么、讲过什么。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 29 行、9 个外部符号。这五档（遮蔽 / 在途 / 读失败 / 读到了 / 还没翻开）是**互斥**的，
 * 摆在一格里；拆开就会让「读失败」与「还没读」在屏上长得一样。
 *
 * ## 五档不许混
 *
 *  1. **`selectedHistoryMasked` 排最前。** 内容按当前权限遮蔽时**不是「没读到」**——
 *     两者混起来会让成员以为记录丢了。
 *  2. **读失败那颗「重试」不是装饰**：`setHistoryInspectRevision(value + 1)` 是重发那一发的
 *     唯一入口（它是 `useEffect` 的依赖）。
 *  3. **`inspectedRound?.roundId === reflectionRoundId` 那一档在读到了之后**。
 *     不比 roundId 的话，翻开 A 轮会显示 B 轮的讲解。
 *  4. **「练过一次不代表整篇已掌握」那句不许删**。它是对「练过 N 次」那句话的**限定**，
 *     少了它这一格会被读成进度条。
 */
import type { ReactElement, RefObject } from "react";
import type { RoundPracticeV1, RoundTeachingViewV1 } from "@astella/shared/note-learning-round-contracts";

export function NotebookRoundRecap(props: {
  /** 这一轮的内容按当前权限遮蔽了。`true` 时下面四档都不看。 */
  readonly masked: boolean;
  readonly busy: boolean;
  readonly failure: string | null;
  /**
   * 翻到的那一轮。**形状直接引用 `RoundTeachingViewV1`**，不在这里另抄一份——
   * 抄一份就要跟着它改两次，而这一格读的是服务端签发的完整视图。
   */
  readonly inspected: { readonly roundId: string; readonly view: RoundTeachingViewV1 } | null;
  /** 当前在回看哪一轮。 */
  readonly reflectionRoundId: string | undefined;
  /** 列表里那一行的状态字；没有选中项就是「还没翻开」。 */
  readonly selectedItem: { readonly phase: "active" | "paused" | "closed"; readonly outcome: string | null } | null;
  readonly stateLabel: (item: { readonly phase: "active" | "paused" | "closed"; readonly outcome: string | null }) => string;
  readonly recordDay: (value: string) => string;
  /** 收的是 `{ phase, outcome }` 那一对——**不是**一个 phase 字符串。 */
  readonly practiceLabel: (practice: Pick<RoundPracticeV1, "phase" | "outcome">) => string;
  readonly onRetry: () => void;
  /** 「查看或留下这一轮的理解」滚到感想区并把焦点交给它的折叠。 */
  readonly onOpenReflection: () => void;
  readonly detailRef: RefObject<HTMLElement | null>;
}): ReactElement {
  const {
    masked, busy, failure, inspected, reflectionRoundId, selectedItem,
    stateLabel, recordDay, practiceLabel, onRetry, onOpenReflection, detailRef,
  } = props;
  // 判空提到这里：三轮 id 不一致时下面那一档整个不画。
  const opened = inspected && inspected.roundId === reflectionRoundId ? inspected : null;
  return (
    <section ref={detailRef} className="notebook-round-recap" aria-label="这一轮回看" data-round-recap="true">
      <h4>这一轮回看</h4>
      {masked ? <p>这轮的内容已按当前权限遮蔽。</p> : busy ? (
        <p role="status">正在翻开这一轮的记录…</p>
      ) : failure ? (
        <p role="alert">记录没读到：{failure}<button type="button" className="text-action" onClick={onRetry}>重试</button></p>
      ) : opened ? (
        <>
          <p className="notebook-round-recap__question">{opened.view.round.drivingQuestion}</p>
          <p className="small notebook-note">这一轮{selectedItem ? stateLabel(selectedItem) : "还没翻开"}</p>
          {opened.view.practices.length ? (
            <ul className="notebook-round-recap__practices">{opened.view.practices.map((practice) => (
              <li key={practice.runId}>{recordDay(practice.startedAt)} · {practiceLabel(practice)}</li>
            ))}</ul>
          ) : null}
          {opened.view.teaching ? (
            <details><summary>查看当时的讲解与例子</summary>
              <p>{opened.view.teaching.content.explanation}</p>
              {opened.view.teaching.content.example ? <p>例子：{opened.view.teaching.content.example}</p> : null}
            </details>
          ) : null}
          <p className="small notebook-note">这轮没有涉及的内容和仍待核对的地方，见上方核心路线；练过一次不代表整篇已掌握。</p>
          <button type="button" className="text-action" onClick={onOpenReflection}>查看或留下这一轮的理解</button>
        </>
      ) : null}
    </section>
  );
}
