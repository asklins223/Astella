/**
 * 作答工位底下的动作条：一行出口、一行主动作、末尾一条说明。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * `LearningRunBody` 剩下 1800 行是一整个巨型条件，整体不可切；但里面**有几块是自足的**
 * ——dock 84 行。
 *
 * ## 分工：这一条管**版式与那颗主动作**，动作语义仍由页面产生
 *
 * `exitActions` / `helpActions` / `moreMenu` 传进来的是**已渲染好的节点**，不是动作描述。
 * 原因很直接：那些动作的标签会随状态变（`给我一点提示` / `提示已经给完` / `再看一层提示`），
 * 「换一个变体」还要看它有没有被语音占住，「看提示」在特定条件下要先弹降级确认框——
 * 全在页面那个 `quickButton` 里。**在这里重写一遍就是埋第二份来源**，
 * 而这一族最贵的 bug 恰恰来自「同一个判据写了两遍」。
 *
 * ## ⚠️ 这一条是本屏**唯一**的 `button primary`，动了它要重跑 `renderer-primary-action-guard`
 *
 * 三个互斥分支：**能作答 →「提交回答」/ checkpoint → 那一步的主动作 / 其余 →「回去」**。
 * 三选一，同屏永远只有一颗重按钮——`DESIGN.md` §Buttons & Fields 定的规矩。
 *
 * ## 四条不许动
 *
 *  1. **复盘 #12：两个出口必须一眼看得见。** 「稍后再做」= 不想做，
 *     「暂时不会」= **不会做**（这是一种真实作答结果，会记为需要复习）。
 *     此前「暂时不会」藏在「更多选择」里，和 skip_task / end 挤在同一个菜单——
 *     那等于把「我不会」和「我不想做」这两件不同的事藏到同一个抽屉里。
 *  2. **提交那颗的禁用条件由页面算好传进来**（`submitDisabled`）。那些条件要读编辑
 *     内容、ordering 有没有碰过、structured_bundle 有没有复核——**都在页面手里**。
 *     这里不重算，重算就会漏一项，而漏一项等于让用户交出一份服务端不认的作答。
 *  3. **说明条从 `.actions` 里搬出来单独占一行**：它此前 `flex-basis:100%` 挤在按钮
 *     同一容器里换行，结果压在按钮身上（实测与「暂停」「给我一点提示」重叠），
 *     而且用的是给深色底的浅色字，落在奶油纸上几乎看不见。**别把它塞回 `.actions`。**
 *  4. **「回答不会自动提交 · …」那句要说在出口那一行**。它是本屏最容易误解的
 *     一件事——用户会以为写完就走掉了。
 */
import type { ReactElement, ReactNode } from "react";
import { ArrowLeft, ArrowRight, LoaderCircle, RotateCcw } from "lucide-react";

/** checkpoint 那一步的主动作。**已渲染好的节点**——语义在页面，这里只摆位。 */
type PrimarySlotV1 = {
  readonly node: ReactNode;
} | null;

export function LearningRunDock(props: {
  readonly statusLine: string;
  readonly exitActions: ReactNode;
  readonly canSubmitUnable: boolean;
  readonly submitting: boolean;
  readonly busy: boolean;
  readonly onSubmitUnable: () => void;
  /** 只有「需要先同步」时页面才传 true——**不是**看 `resyncing`。 */
  readonly showResync: boolean;
  readonly resyncing: boolean;
  readonly onResync: () => void;
  readonly showRetryResult: boolean;
  readonly resultQueryBusy: boolean;
  readonly onRetryResultQuery: () => void;
  readonly helpActions: ReactNode;
  /** 「更多选择」那个下拉的整体；`null` = 这一档没有可收的动作。 */
  readonly moreMenu: ReactNode;
  /** 能作答时印「提交回答」。 */
  readonly canSubmit: boolean;
  readonly submitDisabled: boolean;
  readonly onSubmit: () => void;
  /** checkpoint 那一步的主动作；没有就退回「回去」。 */
  readonly checkpointPrimary: PrimarySlotV1;
  readonly onExit: () => void;
  readonly resultReturnLabel: string;
  /** 语音被占时的说明。空串 = 这次不画。 */
  readonly switchNote: string;
}): ReactElement {
  const {
    statusLine, exitActions, canSubmitUnable, submitting, busy, onSubmitUnable,
    showResync, resyncing, onResync, showRetryResult, resultQueryBusy, onRetryResultQuery,
    helpActions, moreMenu,
    canSubmit, submitDisabled, onSubmit, checkpointPrimary, onExit, resultReturnLabel, switchNote,
  } = props;
  return (
    <footer className="learning-run-dock">
      <div className="learning-run-dock__row learning-run-dock__row--exit">
        <span className="learning-run-dock__status" role="status">{statusLine}</span>
        <div className="actions">
          {exitActions}
          {/* 复盘 #12：两个出口必须一眼看得见——「稍后再做」= 不想做，
              「暂时不会」= 不会做（这是一种真实作答结果，会记为需要复习）。
              此前它藏在「更多选择」里，和 skip_task / end 挤在同一个菜单。 */}
          {canSubmitUnable ? (
            <button
              type="button"
              className="button"
              disabled={busy || submitting}
              onClick={onSubmitUnable}
            >
              <span>暂时不会</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="learning-run-dock__row learning-run-dock__row--act">
        <div className="actions">
          {showResync ? (
            <button type="button" className="button" disabled={resyncing} onClick={onResync}>
              {resyncing ? <LoaderCircle size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
              {resyncing ? "正在同步…" : "同步当前状态"}
            </button>
          ) : null}
          {showRetryResult ? (
            <button type="button" className="button" disabled={resultQueryBusy} onClick={onRetryResultQuery}>
              {resultQueryBusy ? "正在重新检查…" : "重新检查结果"}
            </button>
          ) : null}
          {helpActions}
          {moreMenu}
        </div>
        {canSubmit ? (
          <button
            type="button"
            className="button primary"
            disabled={submitDisabled}
            onClick={onSubmit}
          >
            {submitting ? <LoaderCircle size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
            提交回答
          </button>
        ) : checkpointPrimary ? (
          checkpointPrimary.node
        ) : (
          <button type="button" className="button primary" onClick={onExit}>
            <ArrowLeft size={15} aria-hidden="true" />{resultReturnLabel}
          </button>
        )}
      </div>
      {/* 说明条从 .actions 里搬出来单独占一行：它此前 flex-basis:100% 挤在按钮
          同一容器里换行，结果压在按钮身上（实测与「暂停」「给我一点提示」重叠），
          而且用的是给深色底的浅色字，落在奶油纸上几乎看不见。 */}
      {switchNote ? (
        <p id="learning-run-switch-note" className="learning-run-switch-note" role="status">{switchNote}</p>
      ) : null}
    </footer>
  );
}
