/**
 * 作答工位上那两个「确认框」：看提示、停下来。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * `LearningRunBody` 拆到 1820 行之后，剩下的部分**不再按 state 聚簇可切**——34 个 state
 * 里有 26 个是孤立的，三簇（pending / draft / result）的 setter 又各散 5~12 个区段。
 * 于是改按 JSX 区块切，这两个是外���符号最少的：3 个与 4 个。
 *
 * 它们**是同一族东西**：一张纸、同一套按钮规格、同一种 `role="alertdialog"`。
 * 之前这个文件里甚至有过一段注释说「这两枚 `run-hint-confirmation*` 类名此前没有任何 CSS
 * 接手」——那正是「没有样式接手就等于裸着」这条失败模式，合成一个组件之后连类名都统一了。
 *
 * ## 三条不能动的东西
 *
 *  1. **两个框的 `aria-labelledby` / `aria-describedby` 与标题 id** 是成对的，拆的时候
 *     要连 `id` 一起搬——`doc-reference-guard` 与读屏都靠它。
 *  2. **标题那个 `tabIndex={-1}` + ref 聚焦**：确认框一开，焦点要落到标题上，
 *     否则读屏从页首开始念。
 *  3. 那句「已经写下的内容会替你留着」的承诺**只对 `skip_run` 与 `end` 成立**
 *     （`learning-run-v2-contracts.ts:58/69`），两者都是「离开这次作答」。将来若加了
 *     别的可确认动作，这句要重新核——它承诺的是数据去向，不是氛围文案。
 */
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, RefObject } from "react";
import { Lightbulb } from "lucide-react";

export function RunConfirmations(props: {
  readonly pendingHintAction: unknown;
  readonly hintConfirmationHeadingRef: RefObject<HTMLHeadingElement | null>;
  readonly closeHintConfirmation: () => void;
  readonly confirmHint: () => Promise<void>;
  readonly pendingAction: unknown;
  readonly confirmationHeadingRef: RefObject<HTMLHeadingElement | null>;
  readonly closeConfirmation: () => void;
  readonly confirmPending: () => Promise<void>;
  /** 重新同步中——那颗主动作此时要禁用。 */
  readonly resyncing: boolean;
  readonly handleConfirmationKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}): ReactElement {
  const {
    pendingHintAction,
    hintConfirmationHeadingRef,
    closeHintConfirmation,
    confirmHint,
    pendingAction,
    confirmationHeadingRef,
    closeConfirmation,
    confirmPending,
    resyncing,
    handleConfirmationKeyDown,
  } = props;
  return (
    <>
      {pendingHintAction ? (
        <div className="run-confirmation-backdrop">
          <div className="run-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="learning-run-hint-confirmation-title" aria-describedby="learning-run-hint-confirmation-description" onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); closeHintConfirmation(); }
          }}>
            <Lightbulb size={22} aria-hidden="true" />
            <h2 id="learning-run-hint-confirmation-title" ref={hintConfirmationHeadingRef} tabIndex={-1}>看提示后，本轮会转为练习</h2>
            <p id="learning-run-hint-confirmation-description">提示可以帮你继续走，但这次回答不会写入正式掌握。你仍然可以完成练习，并在之后重新正式验证。</p>
            <div className="actions">
              <button type="button" className="button primary" onClick={() => void confirmHint()}>确认查看提示</button>
              <button type="button" className="button" onClick={closeHintConfirmation}>先自己想想</button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingAction ? (
        <div className="run-confirmation-backdrop">
          <div className="run-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="learning-run-confirmation-title" aria-describedby="learning-run-confirmation-description" onKeyDown={handleConfirmationKeyDown}>
            <h2 id="learning-run-confirmation-title" ref={confirmationHeadingRef} tabIndex={-1}>要现在停下来吗？</h2>
            {/* 只有 skip_run 与 end 需要确认（learning-run-v2-contracts.ts:58/69），两者都是
                「离开这次作答」，所以「草稿替你留着」对它们都成立。将来若加了别的可确认
                动作，这句要重新核——它承诺的是数据去向，不是氛围文案。 */}
            <p id="learning-run-confirmation-description">已经写下的内容会替你留着，回来可以从这里接着做。</p>
            <div className="actions">
              <button type="button" className="button primary" disabled={resyncing} onClick={() => void confirmPending()}>
                {pendingAction === "end" ? "结束这一轮" : "先跳过这一轮"}
              </button>
              <button type="button" className="button" onClick={closeConfirmation}>我继续做</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
